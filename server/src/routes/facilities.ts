import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const router = Router();
const prisma = new PrismaClient();

// GET /api/facilities - List all facilities
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const facilities = await prisma.facility.findMany({
      include: {
        _count: {
          select: { meters: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: facilities,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/facilities/:id - Get facility details
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const facility = await prisma.facility.findUnique({
      where: { id },
      include: {
        meters: {
          orderBy: { isMainMeter: 'desc' },
        },
        equipment: true,
      },
    });

    if (!facility) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
      });
    }

    res.json({
      success: true,
      data: facility,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/facilities - Create facility
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(255),
      address: z.string().max(500).optional(),
      sqft: z.number().positive().optional(),
      buildingType: z.string().optional(),
      timezone: z.string().default('UTC'),
      utilityProvider: z.string().optional(),
      rateSchedule: z.record(z.any()).optional(),
    });

    const input = schema.parse(req.body);

    const facility = await prisma.facility.create({
      data: input,
    });

    res.status(201).json({
      success: true,
      data: facility,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/facilities/:id/meters - Add meter to facility
router.post('/:id/meters', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: facilityId } = req.params;

    const schema = z.object({
      name: z.string().min(1).max(255),
      meterType: z.enum(['electric', 'gas', 'water', 'solar']),
      location: z.string().optional(),
      unit: z.string().default('kWh'),
      maxCapacity: z.number().optional(),
      isMainMeter: z.boolean().default(false),
      metadata: z.record(z.any()).optional(),
    });

    const input = schema.parse(req.body);

    const meter = await prisma.meter.create({
      data: {
        ...input,
        facilityId,
      },
    });

    res.status(201).json({
      success: true,
      data: meter,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/facilities/:id/meters - Get meters for facility
router.get('/:id/meters', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: facilityId } = req.params;

    const meters = await prisma.meter.findMany({
      where: { facilityId },
      orderBy: [{ isMainMeter: 'desc' }, { name: 'asc' }],
    });

    res.json({
      success: true,
      data: meters,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/facilities/:id/equipment - Add equipment
router.post('/:id/equipment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: facilityId } = req.params;

    const schema = z.object({
      meterId: z.string().uuid().optional(),
      name: z.string().min(1).max(255),
      equipmentType: z.string(),
      manufacturer: z.string().optional(),
      model: z.string().optional(),
      ratedPowerKw: z.number().optional(),
      efficiencyRating: z.number().min(0).max(1).optional(),
      installDate: z.string().datetime().optional(),
      maintenanceSchedule: z.record(z.any()).optional(),
    });

    const input = schema.parse(req.body);

    const equipment = await prisma.equipment.create({
      data: {
        ...input,
        facilityId,
        installDate: input.installDate ? new Date(input.installDate) : undefined,
      },
    });

    res.status(201).json({
      success: true,
      data: equipment,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/facilities/:id/equipment - Get equipment for facility
router.get('/:id/equipment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id: facilityId } = req.params;

    const equipment = await prisma.equipment.findMany({
      where: { facilityId },
      include: {
        meter: {
          select: { name: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    res.json({
      success: true,
      data: equipment,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
