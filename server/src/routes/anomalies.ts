import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

// GET /api/anomalies/:facilityId - List anomalies
router.get('/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const querySchema = z.object({
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      resolved: z.enum(['true', 'false']).optional(),
      limit: z.coerce.number().min(1).max(100).default(50),
      offset: z.coerce.number().min(0).default(0),
    });

    const params = querySchema.parse(req.query);

    const where: any = { facilityId };

    if (params.severity) {
      where.severity = params.severity;
    }

    if (params.resolved !== undefined) {
      where.isResolved = params.resolved === 'true';
    }

    const [anomalies, total] = await Promise.all([
      prisma.anomaly.findMany({
        where,
        orderBy: { detectedAt: 'desc' },
        take: params.limit,
        skip: params.offset,
        include: {
          meter: {
            select: { name: true, location: true },
          },
        },
      }),
      prisma.anomaly.count({ where }),
    ]);

    res.json({
      success: true,
      data: anomalies,
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

// GET /api/anomalies/:facilityId/stats - Get anomaly statistics
router.get('/:facilityId/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const querySchema = z.object({
      days: z.coerce.number().min(1).max(365).default(30),
    });

    const { days } = querySchema.parse(req.query);

    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Count by severity
    const bySeverity = await prisma.anomaly.groupBy({
      by: ['severity'],
      where: {
        facilityId,
        detectedAt: { gte: startDate },
      },
      _count: true,
    });

    // Count by type
    const byType = await prisma.anomaly.groupBy({
      by: ['anomalyType'],
      where: {
        facilityId,
        detectedAt: { gte: startDate },
      },
      _count: true,
    });

    // Resolution rate
    const totalAnomalies = await prisma.anomaly.count({
      where: {
        facilityId,
        detectedAt: { gte: startDate },
      },
    });

    const resolvedAnomalies = await prisma.anomaly.count({
      where: {
        facilityId,
        detectedAt: { gte: startDate },
        isResolved: true,
      },
    });

    // Average resolution time
    const resolvedWithTime = await prisma.anomaly.findMany({
      where: {
        facilityId,
        detectedAt: { gte: startDate },
        isResolved: true,
        resolvedAt: { not: null },
      },
      select: {
        detectedAt: true,
        resolvedAt: true,
      },
    });

    const avgResolutionHours = resolvedWithTime.length > 0
      ? resolvedWithTime.reduce((sum, a) => {
          const hours = (a.resolvedAt!.getTime() - a.detectedAt.getTime()) / (1000 * 60 * 60);
          return sum + hours;
        }, 0) / resolvedWithTime.length
      : 0;

    res.json({
      success: true,
      data: {
        period: `${days} days`,
        total: totalAnomalies,
        resolved: resolvedAnomalies,
        resolutionRate: totalAnomalies > 0
          ? Math.round((resolvedAnomalies / totalAnomalies) * 100)
          : 0,
        avgResolutionHours: Math.round(avgResolutionHours * 10) / 10,
        bySeverity: Object.fromEntries(
          bySeverity.map((s) => [s.severity, s._count])
        ),
        byType: Object.fromEntries(
          byType.map((t) => [t.anomalyType, t._count])
        ),
      },
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/anomalies/:id/resolve - Mark anomaly as resolved
router.patch('/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const schema = z.object({
      resolutionNotes: z.string().max(1000).optional(),
    });

    const { resolutionNotes } = schema.parse(req.body);

    const anomaly = await prisma.anomaly.update({
      where: { id },
      data: {
        isResolved: true,
        resolvedAt: new Date(),
        resolutionNotes,
      },
    });

    res.json({
      success: true,
      data: anomaly,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/anomalies - Create anomaly (used by ML service)
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      meterId: z.string().uuid(),
      facilityId: z.string().uuid(),
      anomalyType: z.string(),
      severity: z.enum(['low', 'medium', 'high', 'critical']),
      description: z.string(),
      expectedValue: z.number().optional(),
      actualValue: z.number().optional(),
      deviationPercent: z.number().optional(),
    });

    const input = schema.parse(req.body);

    const anomaly = await prisma.anomaly.create({
      data: {
        ...input,
        detectedAt: new Date(),
      },
    });

    res.status(201).json({
      success: true,
      data: anomaly,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
