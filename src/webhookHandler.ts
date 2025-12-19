import express, { Request, Response } from "express";
import { WebhookRouter } from "voice-router-dev";
import type { UnifiedWebhookEvent } from "voice-router-dev";
import { webhookConfig } from "./config";
import { createLogger } from "./utils";

const logger = createLogger("WebhookHandler");

// MeetingBaas webhook event interface
export interface MeetingBaasWebhookEvent {
  event: string;
  data: {
    bot_id?: string;
    meeting_url?: string;
    // status can be a string or an object with code (for bot.status_change events)
    status?: string | { code?: string; message?: string; [key: string]: any };
    recording_url?: string;
    transcript_url?: string;
    transcript?: {
      text?: string;
      words?: Array<{
        word: string;
        start: number;
        end: number;
        speaker?: string;
      }>;
      speakers?: string[];
    };
    error?: string;
    [key: string]: any;
  };
  timestamp?: string;
}

export class WebhookHandler {
  private app: express.Application;
  private webhookRouter: WebhookRouter;
  private server: any;
  private eventHandlers: Map<
    string,
    (event: UnifiedWebhookEvent) => void | Promise<void>
  > = new Map();
  private meetingBaasHandlers: Map<
    string,
    (event: MeetingBaasWebhookEvent) => void | Promise<void>
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

    // MeetingBaas webhook endpoint
    this.app.post("/webhooks/meetingbaas", async (req: Request, res: Response) => {
      try {
        logger.info("Received MeetingBaas webhook request");

        const event = req.body as MeetingBaasWebhookEvent;

        if (!event.event) {
          logger.error("Invalid MeetingBaas webhook: missing event type");
          return res.status(400).json({
            error: "Invalid webhook payload",
            details: "Missing event type",
          });
        }

        // Process the MeetingBaas webhook event
        await this.processMeetingBaasEvent(event);

        // Acknowledge webhook receipt
        res.status(200).json({
          received: true,
          provider: "meetingbaas",
          eventType: event.event,
        });
      } catch (error: any) {
        logger.error("Error processing MeetingBaas webhook:", error.message);
        res.status(500).json({
          error: "Internal server error",
          details: error.message,
        });
      }
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
   * Process MeetingBaas webhook events
   */
  private async processMeetingBaasEvent(event: MeetingBaasWebhookEvent) {
    const { event: eventType, data } = event;

    logger.info(`Processing MeetingBaas event: ${eventType}`);
    logger.info(`  Bot ID: ${data?.bot_id || "unknown"}`);

    // Handle different MeetingBaas event types
    switch (eventType) {
      case "bot.joining":
        logger.info("Bot is joining the meeting...");
        break;

      case "bot.in_waiting_room":
        logger.info("Bot is in the waiting room");
        break;

      case "bot.joined":
        logger.info("Bot successfully joined the meeting");
        logger.info(`  Meeting URL: ${data?.meeting_url || "unknown"}`);
        break;

      case "bot.left":
        logger.info("Bot left the meeting");
        break;

      case "bot.recording_permission_allowed":
        logger.info("Recording permission granted");
        break;

      case "bot.recording_permission_denied":
        logger.warn("Recording permission denied");
        break;

      case "recording.started":
        logger.info("Recording started");
        break;

      case "recording.ready":
        logger.info("Recording is ready:");
        logger.info(`  Recording URL: ${data?.recording_url || "not available"}`);
        break;

      case "recording.failed":
        logger.error("Recording failed:");
        logger.error(`  Error: ${data?.error || "unknown"}`);
        break;

      case "transcription.ready":
        logger.info("Async transcription is ready:");
        logger.info(`  Transcript URL: ${data?.transcript_url || "not available"}`);
        if (data?.transcript?.text) {
          const preview = data.transcript.text.substring(0, 200);
          logger.info(`  Text preview: ${preview}...`);
        }
        if (data?.transcript?.speakers && data.transcript.speakers.length > 0) {
          logger.info(`  Speakers: ${data.transcript.speakers.join(", ")}`);
        }
        break;

      case "transcription.failed":
        logger.error("Async transcription failed:");
        logger.error(`  Error: ${data?.error || "unknown"}`);
        break;

      case "meeting.ended":
        logger.info("Meeting has ended");
        break;

      default:
        logger.info(`Unknown MeetingBaas event: ${eventType}`);
        logger.info(`  Data: ${JSON.stringify(data, null, 2)}`);
    }

    // Call registered event handlers
    const handler = this.meetingBaasHandlers.get(eventType);
    if (handler) {
      try {
        await handler(event);
      } catch (error: any) {
        logger.error(`Error in MeetingBaas handler for ${eventType}:`, error.message);
      }
    }

    // Call wildcard handler if registered
    const wildcardHandler = this.meetingBaasHandlers.get("*");
    if (wildcardHandler) {
      try {
        await wildcardHandler(event);
      } catch (error: any) {
        logger.error("Error in MeetingBaas wildcard handler:", error.message);
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
   * Register a handler for MeetingBaas webhook events
   * @param eventType MeetingBaas event type (e.g., "bot.joined", "transcription.ready") or "*" for all
   * @param handler Callback function to handle the event
   */
  public onMeetingBaas(
    eventType: string,
    handler: (event: MeetingBaasWebhookEvent) => void | Promise<void>
  ) {
    this.meetingBaasHandlers.set(eventType, handler);
    logger.info(`Registered MeetingBaas handler for event type: ${eventType}`);
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
            logger.info(`Transcription webhook endpoint: ${webhookConfig.path}`);
            logger.info(`MeetingBaas webhook endpoint: /webhooks/meetingbaas`);
            if (!webhookConfig.secret) {
              logger.warn(
                "Webhook server running without signature verification. Set WEBHOOK_SECRET for production use."
              );
            } else {
              logger.info("Signature verification: enabled");
            }
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
