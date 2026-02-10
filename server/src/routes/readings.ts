import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { redis } from '../utils/redis';
import { io } from '../index';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

// Schema for ingesting readings
const readingSchema = z.object({
  meterId: z.string().uuid(),
  timestamp: z.string().datetime().optional(),
  value: z.number(),
  powerKw: z.number().optional(),
  powerFactor: z.number().min(0).max(1).optional(),
  voltage: z.number().optional(),
  currentAmps: z.number().optional(),
  frequency: z.number().optional(),
});

const batchReadingSchema = z.object({
  readings: z.array(readingSchema).min(1).max(1000),
});

// POST /api/readings - Ingest single reading
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = readingSchema.parse(req.body);

    const reading = await prisma.energyReading.create({
      data: {
        meterId: input.meterId,
        time: input.timestamp ? new Date(input.timestamp) : new Date(),
        value: input.value,
        powerKw: input.powerKw,
        powerFactor: input.powerFactor,
        voltage: input.voltage,
        currentAmps: input.currentAmps,
        frequency: input.frequency,
      },
    });

    // Emit real-time update
    io.to(`meter:${input.meterId}`).emit('reading', {
      meterId: input.meterId,
      time: reading.time,
      value: reading.value,
      powerKw: reading.powerKw,
    });

    // Cache latest reading
    await redis.setex(
      `meter:${input.meterId}:latest`,
      60,
      JSON.stringify(reading)
    );

    res.status(201).json({
      success: true,
      data: reading,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/readings/batch - Ingest batch readings
router.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readings } = batchReadingSchema.parse(req.body);

    const data = readings.map((r) => ({
      meterId: r.meterId,
      time: r.timestamp ? new Date(r.timestamp) : new Date(),
      value: r.value,
      powerKw: r.powerKw,
      powerFactor: r.powerFactor,
      voltage: r.voltage,
      currentAmps: r.currentAmps,
      frequency: r.frequency,
    }));

    const result = await prisma.energyReading.createMany({
      data,
      skipDuplicates: true,
    });

    res.status(201).json({
      success: true,
      data: {
        inserted: result.count,
        total: readings.length,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/readings/:meterId - Get readings for a meter
router.get('/:meterId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meterId } = req.params;

    const querySchema = z.object({
      start: z.string().datetime().optional(),
      end: z.string().datetime().optional(),
      limit: z.coerce.number().min(1).max(10000).default(1000),
      resolution: z.enum(['raw', 'minute', 'hour', 'day']).default('raw'),
    });

    const params = querySchema.parse(req.query);

    const where: any = { meterId };

    if (params.start || params.end) {
      where.time = {};
      if (params.start) where.time.gte = new Date(params.start);
      if (params.end) where.time.lte = new Date(params.end);
    }

    // For raw data
    if (params.resolution === 'raw') {
      const readings = await prisma.energyReading.findMany({
        where,
        orderBy: { time: 'desc' },
        take: params.limit,
      });

      return res.json({
        success: true,
        data: readings,
        count: readings.length,
      });
    }

    // For aggregated data, use TimescaleDB continuous aggregates
    // This would use a raw query in production
    const readings = await prisma.energyReading.findMany({
      where,
      orderBy: { time: 'desc' },
      take: params.limit,
    });

    res.json({
      success: true,
      data: readings,
      count: readings.length,
      resolution: params.resolution,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/readings/:meterId/latest - Get latest reading
router.get('/:meterId/latest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meterId } = req.params;

    // Check cache first
    const cached = await redis.get(`meter:${meterId}:latest`);
    if (cached) {
      return res.json({
        success: true,
        data: JSON.parse(cached),
        cached: true,
      });
    }

    const reading = await prisma.energyReading.findFirst({
      where: { meterId },
      orderBy: { time: 'desc' },
    });

    if (!reading) {
      return res.status(404).json({
        success: false,
        error: 'No readings found for this meter',
      });
    }

    // Cache for 60 seconds
    await redis.setex(`meter:${meterId}:latest`, 60, JSON.stringify(reading));

    res.json({
      success: true,
      data: reading,
      cached: false,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/readings/:meterId/aggregate - Get aggregated readings
router.get('/:meterId/aggregate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { meterId } = req.params;

    const querySchema = z.object({
      start: z.string().datetime(),
      end: z.string().datetime(),
      bucket: z.enum(['1m', '5m', '15m', '1h', '1d']).default('1h'),
    });

    const params = querySchema.parse(req.query);

    // In production, this would use TimescaleDB time_bucket function
    // For demo, we'll do basic aggregation
    const readings = await prisma.energyReading.findMany({
      where: {
        meterId,
        time: {
          gte: new Date(params.start),
          lte: new Date(params.end),
        },
      },
      orderBy: { time: 'asc' },
    });

    // Simple aggregation by hour
    const aggregated = new Map<string, { sum: number; count: number; max: number; min: number }>();

    readings.forEach((r) => {
      const bucket = r.time.toISOString().slice(0, 13) + ':00:00.000Z'; // Hour bucket
      const existing = aggregated.get(bucket) || { sum: 0, count: 0, max: -Infinity, min: Infinity };
      const value = Number(r.powerKw || r.value);

      aggregated.set(bucket, {
        sum: existing.sum + value,
        count: existing.count + 1,
        max: Math.max(existing.max, value),
        min: Math.min(existing.min, value),
      });
    });

    const result = Array.from(aggregated.entries()).map(([time, stats]) => ({
      time,
      avg: stats.sum / stats.count,
      max: stats.max,
      min: stats.min,
      count: stats.count,
    }));

    res.json({
      success: true,
      data: result,
      bucket: params.bucket,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
