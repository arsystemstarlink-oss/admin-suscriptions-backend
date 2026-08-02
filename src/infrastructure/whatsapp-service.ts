import twilio from 'twilio';

export interface WhatsAppTemplateMessage {
  to: string;
  templateName: string;
  variables?: Record<string, string>;
}

export interface WhatsAppReceivedMessage {
  from: string;
  body: string;
  messageSid: string;
  profileName?: string;
  timestamp: Date;
}

export class WhatsAppService {
  private client: twilio.Twilio | null = null;

  private getClient(): twilio.Twilio {
    if (!this.client) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;

      if (!accountSid || !authToken) {
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
      }

      this.client = twilio(accountSid, authToken);
    }
    return this.client;
  }

  private getFromNumber(): string {
    const fromNumber = process.env.TWILIO_FROM_NUMBER || '+584223552626';
    return `whatsapp:${fromNumber}`;
  }

  async sendMessage(message: { to: string; body: string }): Promise<string> {
    const sentMessage = await this.getClient().messages.create({
      from: this.getFromNumber(),
      to: `whatsapp:${message.to}`,
      body: message.body,
    });

    return sentMessage.sid;
  }

  async sendTemplate(message: WhatsAppTemplateMessage): Promise<string> {
    const contentVariables = message.variables || {};

    const sentMessage = await this.getClient().messages.create({
      from: this.getFromNumber(),
      to: `whatsapp:${message.to}`,
      contentSid: message.templateName,
      contentVariables: JSON.stringify(contentVariables),
    });

    return sentMessage.sid;
  }

  parseIncomingMessage(body: any): WhatsAppReceivedMessage {
    return {
      from: body.From?.replace('whatsapp:', '') || '',
      body: body.Body || '',
      messageSid: body.MessageSid || '',
      profileName: body.ProfileName,
      timestamp: new Date(),
    };
  }

  validateWebhook(headers: any, body: any, url: string): boolean {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;

    const twilioSignature = headers['x-twilio-signature'];
    if (!twilioSignature) return false;

    return twilio.validateRequest(authToken, twilioSignature, url, body);
  }
}

export const whatsappService = new WhatsAppService();
