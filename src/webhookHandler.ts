import express, { Request, Response } from "express";
import { WebhookRouter } from "voice-router-dev";
import type { UnifiedWebhookEvent } from "voice-router-dev";
import { webhookConfig } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("WebhookHandler");

export class WebhookHandler {
  private app: express.Application;
  private webhookRouter: WebhookRouter;
  private server: any;
  private eventHandlers: Map<
    string,
    (event: UnifiedWebhookEvent) => void | Promise<void>
  > = new Map();

  constructor() {
    this.app = express();
    this.webhookRouter = new WebhookRouter();

    // Middleware to parse JSON and preserve raw body for signature verification
    this.app.use(
      express.json({
        verify: (req: any, res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      })
    );

    this.setupRoutes();
  }

  private setupRoutes() {
    // Main webhook endpoint for all transcription providers
    this.app.post(
      webhookConfig.path,
      async (req: Request, res: Response) => {
        try {
          logger.info("Received webhook request");

          // Route webhook to appropriate handler with auto-detection
          const result = this.webhookRouter.route(req.body, {
            verification: webhookConfig.secret
              ? {
                  signature:
                    (req.headers["x-signature"] as string) ||
                    (req.headers["x-gladia-signature"] as string) ||
                    (req.headers["x-assemblyai-signature"] as string),
                  secret: webhookConfig.secret,
                  rawBody: (req as any).rawBody,
                  timestamp: req.headers["x-timestamp"] as string,
                  headers: req.headers as Record<string, string>,
                }
              : undefined,
            verifySignature: !!webhookConfig.secret,
          });

          // Handle routing failures
          if (!result.success) {
            logger.error(`Webhook routing failed: ${result.error}`);
            return res.status(400).json({
              error: "Invalid webhook payload",
              details: result.error,
            });
          }

          // Handle signature verification failures
          if (
            webhookConfig.secret &&
            result.verified === false
          ) {
            logger.error("Webhook signature verification failed");
            return res.status(401).json({
              error: "Invalid webhook signature",
            });
          }

          // Log webhook event details
          logger.info(`Webhook from provider: ${result.provider}`);
          logger.info(`Event type: ${result.event?.eventType}`);
          logger.info(`Event success: ${result.event?.success}`);

          if (result.event?.data?.id) {
            logger.info(`Transcription ID: ${result.event.data.id}`);
          }

          // Process the webhook event
          await this.processWebhookEvent(result.event!);

          // Acknowledge webhook receipt
          res.status(200).json({
            received: true,
            provider: result.provider,
            eventType: result.event?.eventType,
          });
        } catch (error: any) {
          logger.error("Error processing webhook:", error.message);
          res.status(500).json({
            error: "Internal server error",
            details: error.message,
          });
        }
      }
    );

    // Health check endpoint
    this.app.get("/health", (req: Request, res: Response) => {
      res.status(200).json({
        status: "healthy",
        service: "webhook-handler",
        timestamp: new Date().toISOString(),
      });
    });

    // Provider detection endpoint (for debugging)
    this.app.post("/webhooks/detect", (req: Request, res: Response) => {
      const provider = this.webhookRouter.detectProvider(req.body);
      res.json({
        detectedProvider: provider || null,
        confidence: provider ? "high" : "none",
      });
    });
  }

  private async processWebhookEvent(event: UnifiedWebhookEvent) {
    const { eventType, provider, data } = event;

    logger.info(`Processing ${eventType} event from ${provider}`);

    // Handle different event types
    switch (eventType) {
      case "transcription.completed":
        logger.info("Transcription completed:");
        logger.info(`  ID: ${data?.id}`);
        logger.info(`  Status: ${data?.status}`);
        logger.info(`  Language: ${data?.language || "unknown"}`);
        logger.info(`  Duration: ${data?.duration || "unknown"}s`);
        logger.info(`  Confidence: ${data?.confidence || "unknown"}`);

        if (data?.text) {
          logger.info(`  Text preview: ${data.text.substring(0, 100)}...`);
        }

        if (data?.summary) {
          logger.info(`  Summary: ${data.summary}`);
        }

        if (data?.speakers && data.speakers.length > 0) {
          logger.info(`  Speakers detected: ${data.speakers.length}`);
        }
        break;

      case "transcription.failed":
        logger.error("Transcription failed:");
        logger.error(`  ID: ${data?.id}`);
        logger.error(`  Error: ${data?.error || event.data?.error}`);
        break;

      case "transcription.processing":
        logger.info(`Transcription ${data?.id} is processing...`);
        break;

      case "live.session_started":
        logger.info(`Live session started: ${data?.id}`);
        break;

      case "live.session_ended":
        logger.info(`Live session ended: ${data?.id}`);
        break;

      case "live.transcript":
        // Real-time transcript update
        if (data?.text) {
          logger.info(`Live transcript: ${data.text}`);
        }
        break;

      default:
        logger.warn(`Unknown event type: ${eventType}`);
    }

    // Call registered event handlers
    const handler = this.eventHandlers.get(eventType);
    if (handler) {
      try {
        await handler(event);
      } catch (error: any) {
        logger.error(`Error in event handler for ${eventType}:`, error.message);
      }
    }

    // Call wildcard handler if registered
    const wildcardHandler = this.eventHandlers.get("*");
    if (wildcardHandler) {
      try {
        await wildcardHandler(event);
      } catch (error: any) {
        logger.error("Error in wildcard event handler:", error.message);
      }
    }
  }

  /**
   * Register a handler for specific webhook event types
   * @param eventType Event type or "*" for all events
   * @param handler Callback function to handle the event
   */
  public on(
    eventType: string,
    handler: (event: UnifiedWebhookEvent) => void | Promise<void>
  ) {
    this.eventHandlers.set(eventType, handler);
    logger.info(`Registered handler for event type: ${eventType}`);
  }

  /**
   * Start the webhook server
   */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(
          webhookConfig.port,
          webhookConfig.host,
          () => {
            logger.info(
              `Webhook server listening on ${webhookConfig.host}:${webhookConfig.port}`
            );
            logger.info(`Webhook endpoint: ${webhookConfig.path}`);
            logger.info(
              `Signature verification: ${
                webhookConfig.secret ? "enabled" : "disabled"
              }`
            );
            resolve();
          }
        );

        this.server.on("error", (error: any) => {
          logger.error("Failed to start webhook server:", error.message);
          reject(error);
        });
      } catch (error: any) {
        logger.error("Error starting webhook server:", error.message);
        reject(error);
      }
    });
  }

  /**
   * Stop the webhook server
   */
  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close((error: any) => {
          if (error) {
            logger.error("Error stopping webhook server:", error.message);
            reject(error);
          } else {
            logger.info("Webhook server stopped");
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the webhook URL that should be configured in transcription providers
   * @param publicUrl Public URL of your server (e.g., https://yourdomain.com)
   */
  public getWebhookUrl(publicUrl: string): string {
    const url = new URL(webhookConfig.path, publicUrl);
    return url.toString();
  }

  /**
   * Get the WebhookRouter instance for advanced usage
   */
  public getRouter(): WebhookRouter {
    return this.webhookRouter;
  }
}

/**
 * Create and configure a webhook handler
 */
export function createWebhookHandler(): WebhookHandler {
  return new WebhookHandler();
}
