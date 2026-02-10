import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import axios from 'axios';
import { redis } from '../utils/redis';

const router = Router();
const prisma = new PrismaClient();

// Default carbon intensity values (kg CO2 per kWh) by source
const CARBON_INTENSITIES = {
  grid_average: 0.42, // US average
  natural_gas: 0.55,
  coal: 0.95,
  solar: 0.05,
  wind: 0.01,
  nuclear: 0.02,
  hydro: 0.02,
};

// GET /api/carbon/:facilityId - Get carbon emissions
router.get('/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const querySchema = z.object({
      start: z.string().datetime(),
      end: z.string().datetime(),
      granularity: z.enum(['hour', 'day', 'month']).default('day'),
    });

    const params = querySchema.parse(req.query);

    // Get emissions data
    const emissions = await prisma.carbonEmission.findMany({
      where: {
        facilityId,
        time: {
          gte: new Date(params.start),
          lte: new Date(params.end),
        },
      },
      orderBy: { time: 'asc' },
    });

    // Aggregate by granularity
    const aggregated = new Map<string, { energy: number; carbon: number; count: number }>();

    emissions.forEach((e) => {
      let bucket: string;

      switch (params.granularity) {
        case 'hour':
          bucket = e.time.toISOString().slice(0, 13) + ':00:00.000Z';
          break;
        case 'day':
          bucket = e.time.toISOString().slice(0, 10);
          break;
        case 'month':
          bucket = e.time.toISOString().slice(0, 7);
          break;
      }

      const existing = aggregated.get(bucket) || { energy: 0, carbon: 0, count: 0 };
      aggregated.set(bucket, {
        energy: existing.energy + Number(e.energyKwh),
        carbon: existing.carbon + Number(e.carbonKg),
        count: existing.count + 1,
      });
    });

    const result = Array.from(aggregated.entries()).map(([time, data]) => ({
      time,
      energyKwh: Math.round(data.energy * 100) / 100,
      carbonKg: Math.round(data.carbon * 100) / 100,
      avgIntensity: Math.round((data.carbon / data.energy) * 1000) / 1000,
    }));

    // Calculate totals
    const totalEnergy = result.reduce((sum, r) => sum + r.energyKwh, 0);
    const totalCarbon = result.reduce((sum, r) => sum + r.carbonKg, 0);

    res.json({
      success: true,
      data: {
        timeSeries: result,
        summary: {
          totalEnergyKwh: Math.round(totalEnergy * 100) / 100,
          totalCarbonKg: Math.round(totalCarbon * 100) / 100,
          totalCarbonTons: Math.round((totalCarbon / 1000) * 100) / 100,
          avgIntensity: totalEnergy > 0
            ? Math.round((totalCarbon / totalEnergy) * 1000) / 1000
            : 0,
        },
        granularity: params.granularity,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/carbon/:facilityId/breakdown - Get emissions breakdown
router.get('/:facilityId/breakdown', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const querySchema = z.object({
      start: z.string().datetime(),
      end: z.string().datetime(),
    });

    const params = querySchema.parse(req.query);

    // Get emissions by source
    const emissions = await prisma.carbonEmission.groupBy({
      by: ['source'],
      where: {
        facilityId,
        time: {
          gte: new Date(params.start),
          lte: new Date(params.end),
        },
      },
      _sum: {
        energyKwh: true,
        carbonKg: true,
      },
    });

    const totalCarbon = emissions.reduce(
      (sum, e) => sum + (Number(e._sum.carbonKg) || 0),
      0
    );

    const breakdown = emissions.map((e) => ({
      source: e.source,
      energyKwh: Math.round((Number(e._sum.energyKwh) || 0) * 100) / 100,
      carbonKg: Math.round((Number(e._sum.carbonKg) || 0) * 100) / 100,
      percentage: totalCarbon > 0
        ? Math.round(((Number(e._sum.carbonKg) || 0) / totalCarbon) * 1000) / 10
        : 0,
      intensity: CARBON_INTENSITIES[e.source as keyof typeof CARBON_INTENSITIES] || CARBON_INTENSITIES.grid_average,
    }));

    // Calculate scope 1, 2, 3
    const scope1 = breakdown
      .filter((b) => b.source === 'natural_gas')
      .reduce((sum, b) => sum + b.carbonKg, 0);

    const scope2 = breakdown
      .filter((b) => ['grid_average', 'coal', 'solar', 'wind', 'nuclear', 'hydro'].includes(b.source))
      .reduce((sum, b) => sum + b.carbonKg, 0);

    res.json({
      success: true,
      data: {
        breakdown,
        scopes: {
          scope1: Math.round(scope1 * 100) / 100,
          scope2: Math.round(scope2 * 100) / 100,
          scope3: 0, // Would require supply chain data
        },
        totalCarbonKg: Math.round(totalCarbon * 100) / 100,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/carbon/intensity - Get current grid carbon intensity
router.get('/intensity/current', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const querySchema = z.object({
      region: z.string().default('US'),
    });

    const { region } = querySchema.parse(req.query);

    // Check cache
    const cacheKey = `carbon:intensity:${region}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        data: JSON.parse(cached),
        cached: true,
      });
    }

    // In production, this would call a real-time carbon intensity API
    // For demo, we'll use simulated data with time-of-day variation
    const hour = new Date().getHours();
    let baseIntensity = CARBON_INTENSITIES.grid_average;

    // Simulate lower intensity during day (more solar) and higher at night
    if (hour >= 10 && hour <= 16) {
      baseIntensity *= 0.85; // More renewable during day
    } else if (hour >= 18 || hour <= 6) {
      baseIntensity *= 1.15; // More fossil at night
    }

    const result = {
      region,
      intensity: Math.round(baseIntensity * 1000) / 1000,
      unit: 'kg CO2/kWh',
      timestamp: new Date().toISOString(),
      forecast: {
        next_hour: Math.round(baseIntensity * 0.98 * 1000) / 1000,
        next_4_hours: Math.round(baseIntensity * 1.02 * 1000) / 1000,
      },
      trend: hour >= 10 && hour <= 14 ? 'decreasing' : 'increasing',
    };

    // Cache for 15 minutes
    await redis.setex(cacheKey, 900, JSON.stringify(result));

    res.json({
      success: true,
      data: result,
      cached: false,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/carbon/:facilityId - Record emissions (used internally)
router.post('/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const schema = z.object({
      energyKwh: z.number().positive(),
      source: z.string().default('grid_average'),
      timestamp: z.string().datetime().optional(),
    });

    const input = schema.parse(req.body);

    const intensity = CARBON_INTENSITIES[input.source as keyof typeof CARBON_INTENSITIES]
      || CARBON_INTENSITIES.grid_average;

    const carbonKg = input.energyKwh * intensity;

    const emission = await prisma.carbonEmission.create({
      data: {
        facilityId,
        time: input.timestamp ? new Date(input.timestamp) : new Date(),
        energyKwh: input.energyKwh,
        carbonKg,
        gridIntensity: intensity,
        source: input.source,
      },
    });

    res.status(201).json({
      success: true,
      data: emission,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
