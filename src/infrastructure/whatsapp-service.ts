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

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return null;

  return {
    accountSid,
    authToken,
    phoneNumber: normalizePhoneNumber(process.env.TWILIO_FROM_NUMBER || '+584223552626'),
  };
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
    const token = authToken || process.env.TWILIO_AUTH_TOKEN;
    if (!token) return false;

    const twilioSignature = headers['x-twilio-signature'];
    if (!twilioSignature) return false;

    return twilio.validateRequest(token, twilioSignature, url, body);
  }
}

export const whatsappService = new WhatsAppService();
