import twilio from 'twilio';
import type { MessageListInstanceCreateOptions } from 'twilio/lib/rest/api/v2010/account/message';
import { Organization } from '../domain/entities';
import { isFirestoreError } from './firestore-error';

export interface WhatsAppTemplateMessage {
  to: string;
  templateName: string;
  variables?: Record<string, string>;
}

export interface WhatsAppReceivedMessage {
  from: string;
  to: string;
  body: string;
  messageSid: string;
  profileName?: string;
  timestamp: Date;
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  phoneNumber: string;
}

export function normalizePhoneNumber(value: string): string {
  return value.trim().replace(/^whatsapp:/, '');
}

export function resolveTwilioCredentials(
  organization?: Organization | null
): TwilioCredentials | null {
  const orgTwilio = organization?.twilio;
  if (
    orgTwilio &&
    orgTwilio.enabled !== false &&
    orgTwilio.accountSid &&
    orgTwilio.authToken &&
    orgTwilio.phoneNumber
  ) {
    return {
      accountSid: orgTwilio.accountSid.trim(),
      authToken: orgTwilio.authToken.trim(),
      phoneNumber: normalizePhoneNumber(orgTwilio.phoneNumber),
    };
  }

  return null;
}

export interface TwilioErrorInfo {
  code: number;
  message: string;
  moreInfo?: string;
  status?: number;
}

export function extractTwilioError(error: unknown): TwilioErrorInfo | null {
  if (!error || typeof error !== 'object') return null;

  if (isFirestoreError(error)) return null;

  const candidate = error as Record<string, unknown>;
  const code = candidate.code;
  const message = candidate.message;

  if (typeof code !== 'number' || typeof message !== 'string') return null;

  return {
    code,
    message,
    moreInfo: typeof candidate.moreInfo === 'string' ? candidate.moreInfo : undefined,
    status: typeof candidate.status === 'number' ? candidate.status : undefined,
  };
}

export function formatTwilioError(error: unknown): string {
  const twilioError = extractTwilioError(error);
  if (twilioError) {
    return `Twilio error ${twilioError.code}: ${twilioError.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

const RATE_LIMIT_CODES = new Set<number>([8, 21613, 21614, 21612, 429, 408]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTwilioError(error: unknown): boolean {
  const info = extractTwilioError(error);
  if (!info) return false;
  if (RATE_LIMIT_CODES.has(info.code)) return true;
  const msg = info.message.toLowerCase();
  return msg.includes('rate limit') || msg.includes('quota exceeded') || msg.includes('resource_exhausted');
}

export class WhatsAppService {
  private clients = new Map<string, { authToken: string; client: twilio.Twilio }>();

  private getClient(credentials: TwilioCredentials): twilio.Twilio {
    const cached = this.clients.get(credentials.accountSid);
    if (!cached || cached.authToken !== credentials.authToken) {
      const client = twilio(credentials.accountSid, credentials.authToken, {
        maxRetries: MAX_RETRIES,
        maxRetryDelay: 30000,
        timeout: 30000,
      });
      this.clients.set(credentials.accountSid, { authToken: credentials.authToken, client });
      return client;
    }
    return cached.client;
  }

  private async createMessageWithRetry(
    params: MessageListInstanceCreateOptions,
    credentials: TwilioCredentials
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const sentMessage = await this.getClient(credentials).messages.create(params);
        return sentMessage.sid;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_RETRIES || !isRetryableTwilioError(err)) {
          throw err;
        }
        const backoff = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[Twilio] Rate limit detectado, reintentando (attempt ${attempt + 1}/${MAX_RETRIES + 1}) tras ${backoff}ms:`,
          (err as Record<string, unknown>)?.message
        );
        await delay(backoff);
      }
    }
    throw lastError;
  }

  async sendMessage(
    message: { to: string; body: string },
    organization?: Organization | null
  ): Promise<string> {
    const credentials = resolveTwilioCredentials(organization);
    if (!credentials) {
      throw new Error('Credenciales de Twilio no configuradas para esta organización.');
    }

    return this.createMessageWithRetry(
      {
        from: `whatsapp:${credentials.phoneNumber}`,
        to: `whatsapp:${message.to}`,
        body: message.body,
      },
      credentials
    );
  }

  async sendTemplate(
    message: WhatsAppTemplateMessage,
    organization?: Organization | null
  ): Promise<string> {
    const credentials = resolveTwilioCredentials(organization);
    if (!credentials) {
      throw new Error('Credenciales de Twilio no configuradas para esta organización.');
    }

    const contentVariables = message.variables || {};

    const payload = {
      from: `whatsapp:${credentials.phoneNumber}`,
      to: `whatsapp:${message.to}`,
      contentSid: message.templateName,
      contentVariables: JSON.stringify(contentVariables),
    };

    return this.createMessageWithRetry(payload, credentials);
  }

  parseIncomingMessage(body: any): WhatsAppReceivedMessage {
    return {
      from: body.From?.replace('whatsapp:', '') || '',
      to: body.To?.replace('whatsapp:', '') || '',
      body: body.Body || '',
      messageSid: body.MessageSid || '',
      profileName: body.ProfileName,
      timestamp: new Date(),
    };
  }

  validateWebhook(headers: any, body: any, url: string, authToken?: string): boolean {
    if (!authToken) return false;

    const twilioSignature = headers['x-twilio-signature'];
    if (!twilioSignature) return false;

    return twilio.validateRequest(authToken, twilioSignature, url, body);
  }
}

export const whatsappService = new WhatsAppService();
