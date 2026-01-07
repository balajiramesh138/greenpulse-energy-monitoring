import mqtt from 'mqtt';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';

const prisma = new PrismaClient();

let mqttClient: mqtt.MqttClient | null = null;

export function initMqttClient(io: Server) {
  const brokerUrl = process.env.MQTT_BROKER_URL;

  if (!brokerUrl) {
    logger.warn('MQTT broker URL not configured, skipping MQTT initialization');
    return;
  }

  const options: mqtt.IClientOptions = {
    clientId: `greenpulse-server-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000,
  };

  if (process.env.MQTT_USERNAME) {
    options.username = process.env.MQTT_USERNAME;
    options.password = process.env.MQTT_PASSWORD;
  }

  mqttClient = mqtt.connect(brokerUrl, options);

  mqttClient.on('connect', () => {
    logger.info('Connected to MQTT broker');

    // Subscribe to meter reading topics
    mqttClient!.subscribe('meters/+/readings', (err) => {
      if (err) {
        logger.error('Failed to subscribe to meter readings:', err);
      } else {
        logger.info('Subscribed to meters/+/readings');
      }
    });

    // Subscribe to device status topics
    mqttClient!.subscribe('devices/+/status', (err) => {
      if (err) {
        logger.error('Failed to subscribe to device status:', err);
      }
    });
  });

  mqttClient.on('message', async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());

      // Handle meter readings
      if (topic.startsWith('meters/') && topic.endsWith('/readings')) {
        await handleMeterReading(topic, payload, io);
      }

      // Handle device status updates
      if (topic.startsWith('devices/') && topic.endsWith('/status')) {
        await handleDeviceStatus(topic, payload, io);
      }
    } catch (error) {
      logger.error('Error processing MQTT message:', error);
    }
  });

  mqttClient.on('error', (error) => {
    logger.error('MQTT client error:', error);
  });

  mqttClient.on('reconnect', () => {
    logger.info('Reconnecting to MQTT broker...');
  });

  mqttClient.on('close', () => {
    logger.warn('MQTT connection closed');
  });
}

async function handleMeterReading(
  topic: string,
  payload: any,
  io: Server
) {
  // Extract meter ID from topic: meters/{meterId}/readings
  const meterId = topic.split('/')[1];

  const reading = {
    meterId,
    time: payload.timestamp ? new Date(payload.timestamp) : new Date(),
    value: payload.value || payload.kwh || 0,
    powerKw: payload.power_kw || payload.powerKw,
    powerFactor: payload.power_factor || payload.powerFactor,
    voltage: payload.voltage,
    currentAmps: payload.current || payload.currentAmps,
    frequency: payload.frequency,
    qualityScore: payload.quality || 100,
  };

  // Save to database
  try {
    await prisma.energyReading.create({
      data: reading,
    });

    // Update cache
    await redis.setex(
      `meter:${meterId}:latest`,
      60,
      JSON.stringify(reading)
    );

    // Emit to connected clients
    io.to(`meter:${meterId}`).emit('reading', {
      meterId,
      time: reading.time,
      value: reading.value,
      powerKw: reading.powerKw,
    });

    // Check for anomalies (simple threshold check)
    await checkForAnomalies(meterId, reading, io);

  } catch (error) {
    logger.error(`Failed to save reading for meter ${meterId}:`, error);
  }
}

async function handleDeviceStatus(
  topic: string,
  payload: any,
  io: Server
) {
  const deviceId = topic.split('/')[1];

  logger.info(`Device ${deviceId} status: ${payload.status}`);

  // Emit status update to connected clients
  io.emit('device:status', {
    deviceId,
    status: payload.status,
    timestamp: new Date().toISOString(),
  });
}

async function checkForAnomalies(
  meterId: string,
  reading: any,
  io: Server
) {
  try {
    // Get meter and recent readings for baseline
    const meter = await prisma.meter.findUnique({
      where: { id: meterId },
      select: { facilityId: true, maxCapacity: true, name: true },
    });

    if (!meter) return;

    // Simple anomaly detection: check if reading exceeds max capacity
    if (meter.maxCapacity && reading.powerKw > meter.maxCapacity) {
      const anomaly = await prisma.anomaly.create({
        data: {
          meterId,
          facilityId: meter.facilityId,
          detectedAt: new Date(),
          anomalyType: 'over_capacity',
          severity: 'high',
          description: `Power consumption (${reading.powerKw} kW) exceeds meter capacity (${meter.maxCapacity} kW)`,
          expectedValue: meter.maxCapacity,
          actualValue: reading.powerKw,
          deviationPercent: ((reading.powerKw - meter.maxCapacity) / meter.maxCapacity) * 100,
        },
      });

      // Emit anomaly alert
      io.to(`facility:${meter.facilityId}`).emit('anomaly', {
        id: anomaly.id,
        meterId,
        meterName: meter.name,
        type: 'over_capacity',
        severity: 'high',
        message: anomaly.description,
        timestamp: anomaly.detectedAt,
      });
    }

    // Check for sudden spikes (>50% increase from recent average)
    const recentReadings = await prisma.energyReading.findMany({
      where: {
        meterId,
        time: {
          gte: new Date(Date.now() - 60 * 60 * 1000), // Last hour
        },
      },
      orderBy: { time: 'desc' },
      take: 60,
    });

    if (recentReadings.length >= 10) {
      const avgPower = recentReadings.reduce(
        (sum, r) => sum + Number(r.powerKw || 0),
        0
      ) / recentReadings.length;

      if (reading.powerKw > avgPower * 1.5) {
        const anomaly = await prisma.anomaly.create({
          data: {
            meterId,
            facilityId: meter.facilityId,
            detectedAt: new Date(),
            anomalyType: 'sudden_spike',
            severity: 'medium',
            description: `Sudden power spike detected: ${reading.powerKw.toFixed(1)} kW (avg: ${avgPower.toFixed(1)} kW)`,
            expectedValue: avgPower,
            actualValue: reading.powerKw,
            deviationPercent: ((reading.powerKw - avgPower) / avgPower) * 100,
          },
        });

        io.to(`facility:${meter.facilityId}`).emit('anomaly', {
          id: anomaly.id,
          meterId,
          meterName: meter.name,
          type: 'sudden_spike',
          severity: 'medium',
          message: anomaly.description,
          timestamp: anomaly.detectedAt,
        });
      }
    }
  } catch (error) {
    logger.error('Error checking for anomalies:', error);
  }
}

export function getMqttClient(): mqtt.MqttClient | null {
  return mqttClient;
}
