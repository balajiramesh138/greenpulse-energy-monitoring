import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { redis } from '../utils/redis';

const router = Router();
const prisma = new PrismaClient();

// GET /api/analytics/summary/:facilityId - Get energy summary
router.get('/summary/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const querySchema = z.object({
      period: z.enum(['today', 'week', 'month', 'year']).default('today'),
    });

    const { period } = querySchema.parse(req.query);

    // Calculate date range
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case 'today':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
    }

    // Get meters for facility
    const meters = await prisma.meter.findMany({
      where: { facilityId },
      select: { id: true, name: true, meterType: true, isMainMeter: true },
    });

    // Get readings for all meters
    const meterIds = meters.map((m) => m.id);

    const readings = await prisma.energyReading.findMany({
      where: {
        meterId: { in: meterIds },
        time: { gte: startDate },
      },
      orderBy: { time: 'asc' },
    });

    // Calculate metrics
    const totalConsumption = readings.reduce((sum, r) => sum + Number(r.value), 0);
    const peakDemand = Math.max(...readings.map((r) => Number(r.powerKw || 0)));
    const avgPowerFactor = readings.reduce((sum, r) => sum + Number(r.powerFactor || 0.9), 0) / readings.length;

    // Get previous period for comparison
    const periodDuration = now.getTime() - startDate.getTime();
    const prevStartDate = new Date(startDate.getTime() - periodDuration);

    const prevReadings = await prisma.energyReading.findMany({
      where: {
        meterId: { in: meterIds },
        time: {
          gte: prevStartDate,
          lt: startDate,
        },
      },
    });

    const prevTotalConsumption = prevReadings.reduce((sum, r) => sum + Number(r.value), 0);
    const consumptionChange = prevTotalConsumption > 0
      ? ((totalConsumption - prevTotalConsumption) / prevTotalConsumption) * 100
      : 0;

    // Get facility info
    const facility = await prisma.facility.findUnique({
      where: { id: facilityId },
      select: { name: true, sqft: true },
    });

    const energyPerSqft = facility?.sqft
      ? totalConsumption / facility.sqft
      : null;

    res.json({
      success: true,
      data: {
        facility: facility?.name,
        period,
        metrics: {
          totalConsumption: Math.round(totalConsumption * 100) / 100,
          totalConsumptionUnit: 'kWh',
          peakDemand: Math.round(peakDemand * 100) / 100,
          peakDemandUnit: 'kW',
          avgPowerFactor: Math.round(avgPowerFactor * 100) / 100,
          energyPerSqft: energyPerSqft ? Math.round(energyPerSqft * 1000) / 1000 : null,
        },
        comparison: {
          consumptionChange: Math.round(consumptionChange * 10) / 10,
          trend: consumptionChange > 0 ? 'up' : consumptionChange < 0 ? 'down' : 'flat',
        },
        meterCount: meters.length,
        readingCount: readings.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/breakdown/:facilityId - Get consumption breakdown
router.get('/breakdown/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const querySchema = z.object({
      start: z.string().datetime(),
      end: z.string().datetime(),
      groupBy: z.enum(['meter', 'equipment_type', 'hour', 'day']).default('meter'),
    });

    const params = querySchema.parse(req.query);

    // Get meters with equipment info
    const meters = await prisma.meter.findMany({
      where: { facilityId },
      include: {
        equipment: {
          select: { equipmentType: true },
        },
      },
    });

    const meterIds = meters.map((m) => m.id);

    // Get readings
    const readings = await prisma.energyReading.findMany({
      where: {
        meterId: { in: meterIds },
        time: {
          gte: new Date(params.start),
          lte: new Date(params.end),
        },
      },
    });

    // Group by selected dimension
    const breakdown = new Map<string, number>();

    readings.forEach((r) => {
      let key: string;

      switch (params.groupBy) {
        case 'meter':
          const meter = meters.find((m) => m.id === r.meterId);
          key = meter?.name || r.meterId;
          break;
        case 'equipment_type':
          const meterWithEquip = meters.find((m) => m.id === r.meterId);
          key = meterWithEquip?.equipment?.[0]?.equipmentType || 'Other';
          break;
        case 'hour':
          key = r.time.getHours().toString().padStart(2, '0') + ':00';
          break;
        case 'day':
          key = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.time.getDay()];
          break;
        default:
          key = 'Unknown';
      }

      breakdown.set(key, (breakdown.get(key) || 0) + Number(r.value));
    });

    const totalConsumption = Array.from(breakdown.values()).reduce((a, b) => a + b, 0);

    const result = Array.from(breakdown.entries())
      .map(([name, value]) => ({
        name,
        value: Math.round(value * 100) / 100,
        percentage: Math.round((value / totalConsumption) * 1000) / 10,
      }))
      .sort((a, b) => b.value - a.value);

    res.json({
      success: true,
      data: {
        breakdown: result,
        totalConsumption: Math.round(totalConsumption * 100) / 100,
        groupBy: params.groupBy,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/analytics/cost/:facilityId - Get cost analysis
router.get('/cost/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const querySchema = z.object({
      start: z.string().datetime(),
      end: z.string().datetime(),
    });

    const params = querySchema.parse(req.query);

    // Get facility with rate schedule
    const facility = await prisma.facility.findUnique({
      where: { id: facilityId },
      select: { name: true, rateSchedule: true },
    });

    if (!facility) {
      return res.status(404).json({
        success: false,
        error: 'Facility not found',
      });
    }

    // Default rate schedule if not set
    const rates = (facility.rateSchedule as any) || {
      energyRate: 0.12, // $/kWh
      demandRate: 15.0, // $/kW
      peakMultiplier: 1.5,
      peakHours: { start: 14, end: 19 },
    };

    // Get meters and readings
    const meters = await prisma.meter.findMany({
      where: { facilityId },
      select: { id: true },
    });

    const readings = await prisma.energyReading.findMany({
      where: {
        meterId: { in: meters.map((m) => m.id) },
        time: {
          gte: new Date(params.start),
          lte: new Date(params.end),
        },
      },
    });

    // Calculate costs
    let onPeakConsumption = 0;
    let offPeakConsumption = 0;
    let peakDemand = 0;

    readings.forEach((r) => {
      const hour = r.time.getHours();
      const isPeak = hour >= rates.peakHours.start && hour < rates.peakHours.end;

      if (isPeak) {
        onPeakConsumption += Number(r.value);
      } else {
        offPeakConsumption += Number(r.value);
      }

      if (Number(r.powerKw) > peakDemand) {
        peakDemand = Number(r.powerKw);
      }
    });

    const onPeakCost = onPeakConsumption * rates.energyRate * rates.peakMultiplier;
    const offPeakCost = offPeakConsumption * rates.energyRate;
    const demandCost = peakDemand * rates.demandRate;
    const totalCost = onPeakCost + offPeakCost + demandCost;

    res.json({
      success: true,
      data: {
        summary: {
          totalCost: Math.round(totalCost * 100) / 100,
          energyCost: Math.round((onPeakCost + offPeakCost) * 100) / 100,
          demandCost: Math.round(demandCost * 100) / 100,
        },
        breakdown: {
          onPeak: {
            consumption: Math.round(onPeakConsumption * 100) / 100,
            cost: Math.round(onPeakCost * 100) / 100,
            rate: rates.energyRate * rates.peakMultiplier,
          },
          offPeak: {
            consumption: Math.round(offPeakConsumption * 100) / 100,
            cost: Math.round(offPeakCost * 100) / 100,
            rate: rates.energyRate,
          },
          demand: {
            peakKw: Math.round(peakDemand * 100) / 100,
            cost: Math.round(demandCost * 100) / 100,
            rate: rates.demandRate,
          },
        },
        recommendations: generateCostRecommendations(onPeakConsumption, offPeakConsumption, peakDemand),
      },
    });
  } catch (error) {
    next(error);
  }
});

function generateCostRecommendations(
  onPeakKwh: number,
  offPeakKwh: number,
  peakDemandKw: number
): string[] {
  const recommendations: string[] = [];

  const peakRatio = onPeakKwh / (onPeakKwh + offPeakKwh);

  if (peakRatio > 0.4) {
    recommendations.push(
      'Consider shifting non-critical loads to off-peak hours to reduce energy costs by up to 20%.'
    );
  }

  if (peakDemandKw > 100) {
    recommendations.push(
      'High peak demand detected. Staggering equipment startup times could reduce demand charges.'
    );
  }

  if (recommendations.length === 0) {
    recommendations.push('Energy usage patterns are well-optimized for the current rate structure.');
  }

  return recommendations;
}

export default router;
