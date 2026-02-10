import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

// GET /api/alerts/rules/:facilityId - Get alert rules
router.get('/rules/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const rules = await prisma.alertRule.findMany({
      where: { facilityId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: rules,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/alerts/rules - Create alert rule
router.post('/rules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      facilityId: z.string().uuid(),
      name: z.string().min(1).max(255),
      conditionType: z.enum(['threshold', 'anomaly', 'schedule']),
      metric: z.string(),
      operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
      thresholdValue: z.number(),
      notificationChannels: z.array(z.object({
        type: z.enum(['email', 'slack', 'sms', 'webhook']),
        target: z.string(),
      })),
      isActive: z.boolean().default(true),
      cooldownMinutes: z.number().min(0).default(60),
    });

    const input = schema.parse(req.body);

    const rule = await prisma.alertRule.create({
      data: input,
    });

    res.status(201).json({
      success: true,
      data: rule,
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/alerts/rules/:id - Update alert rule
router.patch('/rules/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      thresholdValue: z.number().optional(),
      isActive: z.boolean().optional(),
      cooldownMinutes: z.number().min(0).optional(),
      notificationChannels: z.array(z.object({
        type: z.enum(['email', 'slack', 'sms', 'webhook']),
        target: z.string(),
      })).optional(),
    });

    const input = schema.parse(req.body);

    const rule = await prisma.alertRule.update({
      where: { id },
      data: input,
    });

    res.json({
      success: true,
      data: rule,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/alerts/rules/:id - Delete alert rule
router.delete('/rules/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    await prisma.alertRule.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: 'Alert rule deleted',
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/alerts/events - Get alert history
router.get('/events', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const querySchema = z.object({
      facilityId: z.string().uuid().optional(),
      acknowledged: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
    });

    const params = querySchema.parse(req.query);

    const where: any = {};

    if (params.facilityId) {
      const rules = await prisma.alertRule.findMany({
        where: { facilityId: params.facilityId },
        select: { id: true },
      });
      where.ruleId = { in: rules.map((r) => r.id) };
    }

    if (params.acknowledged !== undefined) {
      if (params.acknowledged === 'true') {
        where.acknowledgedAt = { not: null };
      } else {
        where.acknowledgedAt = null;
      }
    }

    const [events, total] = await Promise.all([
      prisma.alertEvent.findMany({
        where,
        orderBy: { triggeredAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: {
          rule: {
            select: { name: true, metric: true, thresholdValue: true },
          },
        },
      }),
      prisma.alertEvent.count({ where }),
    ]);

    res.json({
      success: true,
      data: events,
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/alerts/acknowledge/:id - Acknowledge alert
router.post('/acknowledge/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const schema = z.object({
      userId: z.string().uuid().optional(),
    });

    const { userId } = schema.parse(req.body);

    const event = await prisma.alertEvent.update({
      where: { id },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedBy: userId,
      },
    });

    res.json({
      success: true,
      data: event,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/alerts/test/:ruleId - Test alert rule
router.post('/test/:ruleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ruleId } = req.params;

    const rule = await prisma.alertRule.findUnique({
      where: { id: ruleId },
    });

    if (!rule) {
      return res.status(404).json({
        success: false,
        error: 'Alert rule not found',
      });
    }

    // Create test event
    const event = await prisma.alertEvent.create({
      data: {
        ruleId,
        triggeredAt: new Date(),
        value: rule.thresholdValue,
        message: `[TEST] Alert test for rule: ${rule.name}`,
        metadata: { isTest: true },
      },
    });

    // In production, this would actually send notifications
    res.json({
      success: true,
      data: event,
      message: 'Test alert sent',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
