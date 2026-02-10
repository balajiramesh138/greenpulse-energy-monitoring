import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import axios from 'axios';
import { logger } from '../utils/logger';

const router = Router();
const prisma = new PrismaClient();

// POST /api/forecast/:facilityId - Generate new forecast
router.post('/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const schema = z.object({
      horizonHours: z.number().min(1).max(168).default(24), // Max 7 days
    });

    const { horizonHours } = schema.parse(req.body);

    // Get facility meters
    const meters = await prisma.meter.findMany({
      where: { facilityId, isMainMeter: true },
      select: { id: true },
    });

    if (meters.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No main meters found for facility',
      });
    }

    // Get historical data for ML model
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

    const readings = await prisma.energyReading.findMany({
      where: {
        meterId: { in: meters.map((m) => m.id) },
        time: { gte: startDate },
      },
      orderBy: { time: 'asc' },
    });

    // Call ML service
    const mlServiceUrl = process.env.ML_SERVICE_URL || 'http://localhost:8000';

    try {
      const response = await axios.post(`${mlServiceUrl}/forecast`, {
        facility_id: facilityId,
        horizon_hours: horizonHours,
        historical_data: readings.map((r) => ({
          timestamp: r.time.toISOString(),
          value: Number(r.powerKw || r.value),
        })),
      });

      const forecast = response.data;

      // Save forecast to database
      await prisma.demandForecast.create({
        data: {
          facilityId,
          forecastHorizonHours: horizonHours,
          modelVersion: forecast.model_version,
          predictions: forecast.predictions,
          accuracyMetrics: forecast.accuracy_metrics,
        },
      });

      return res.json({
        success: true,
        data: {
          facilityId,
          horizonHours,
          predictions: forecast.predictions,
          modelVersion: forecast.model_version,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (mlError) {
      logger.warn('ML service unavailable, using fallback forecast');
    }

    // Fallback: Simple moving average forecast
    const hourlyAverages = new Map<number, number[]>();

    readings.forEach((r) => {
      const hour = r.time.getHours();
      if (!hourlyAverages.has(hour)) {
        hourlyAverages.set(hour, []);
      }
      hourlyAverages.get(hour)!.push(Number(r.powerKw || r.value));
    });

    const predictions: Array<{ timestamp: string; predicted_kw: number; lower_bound: number; upper_bound: number }> = [];
    const now = new Date();

    for (let i = 1; i <= horizonHours; i++) {
      const targetTime = new Date(now.getTime() + i * 60 * 60 * 1000);
      const hour = targetTime.getHours();
      const values = hourlyAverages.get(hour) || [0];
      const avgValue = values.reduce((a, b) => a + b, 0) / values.length;
      const stdDev = Math.sqrt(
        values.reduce((sum, v) => sum + Math.pow(v - avgValue, 2), 0) / values.length
      );

      predictions.push({
        timestamp: targetTime.toISOString(),
        predicted_kw: Math.round(avgValue * 100) / 100,
        lower_bound: Math.round((avgValue - 1.96 * stdDev) * 100) / 100,
        upper_bound: Math.round((avgValue + 1.96 * stdDev) * 100) / 100,
      });
    }

    // Save fallback forecast
    await prisma.demandForecast.create({
      data: {
        facilityId,
        forecastHorizonHours: horizonHours,
        modelVersion: 'moving_average_v1',
        predictions,
        accuracyMetrics: { method: 'fallback_moving_average' },
      },
    });

    res.json({
      success: true,
      data: {
        facilityId,
        horizonHours,
        predictions,
        modelVersion: 'moving_average_v1',
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/forecast/:facilityId/latest - Get latest forecast
router.get('/:facilityId/latest', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    const forecast = await prisma.demandForecast.findFirst({
      where: { facilityId },
      orderBy: { createdAt: 'desc' },
    });

    if (!forecast) {
      return res.status(404).json({
        success: false,
        error: 'No forecasts found for this facility',
      });
    }

    res.json({
      success: true,
      data: {
        id: forecast.id,
        facilityId: forecast.facilityId,
        horizonHours: forecast.forecastHorizonHours,
        predictions: forecast.predictions,
        modelVersion: forecast.modelVersion,
        createdAt: forecast.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/forecast/accuracy - Get forecast accuracy metrics
router.get('/accuracy/:facilityId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { facilityId } = req.params;

    // Get recent forecasts
    const forecasts = await prisma.demandForecast.findMany({
      where: { facilityId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (forecasts.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No forecasts found for accuracy calculation',
      });
    }

    // In production, this would compare predictions to actual values
    // For demo, we'll return mock accuracy metrics
    res.json({
      success: true,
      data: {
        facilityId,
        metrics: {
          mape: 4.8, // Mean Absolute Percentage Error
          rmse: 12.5, // Root Mean Square Error
          mae: 8.2, // Mean Absolute Error
          r2: 0.92, // R-squared
        },
        forecastCount: forecasts.length,
        evaluationPeriod: '30 days',
        modelVersion: forecasts[0]?.modelVersion,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
