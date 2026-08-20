import twilio from 'twilio';
import { Organization } from '../domain/entities';

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

export class WhatsAppService {
  private clients = new Map<string, twilio.Twilio>();

  private getClient(credentials: TwilioCredentials): twilio.Twilio {
    let client = this.clients.get(credentials.accountSid);
    if (!client) {
      client = twilio(credentials.accountSid, credentials.authToken);
      this.clients.set(credentials.accountSid, client);
    }
    return client;
  }

  async sendMessage(
    message: { to: string; body: string },
    organization?: Organization | null
  ): Promise<string> {
    const credentials = resolveTwilioCredentials(organization);
    if (!credentials) {
      throw new Error('Credenciales de Twilio no configuradas para esta organización.');
    }

    const sentMessage = await this.getClient(credentials).messages.create({
      from: `whatsapp:${credentials.phoneNumber}`,
      to: `whatsapp:${message.to}`,
      body: message.body,
    });

    return sentMessage.sid;
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

    const sentMessage = await this.getClient(credentials).messages.create(payload);

    return sentMessage.sid;
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
