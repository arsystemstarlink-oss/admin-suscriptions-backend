import { Router, Request, Response, NextFunction } from 'express';
import { whatsappService } from '../../infrastructure/whatsapp-service';
import { whatsappMessageRepository, clientRepository } from '../../infrastructure/repositories';
import { BusinessError, WhatsAppMessage } from '../../domain/entities';
import { createId } from '../../domain/business-rules';

const router = Router();

router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { to, body, templateName, variables } = req.body;

    if (!to) {
      throw new BusinessError('INVALID_DATA', 'Número de teléfono es obligatorio.');
    }

    if (!body && !templateName) {
      throw new BusinessError('INVALID_DATA', 'Mensaje o template son obligatorios.');
    }

    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    if (!phoneRegex.test(to)) {
      throw new BusinessError('INVALID_PHONE', 'Número de teléfono inválido.');
    }

    let messageSid: string;
    let messageBody = body || '';

    if (templateName) {
      messageSid = await whatsappService.sendTemplate({
        to,
        templateName,
        variables,
      });
    } else {
      messageSid = await whatsappService.sendMessage({ to, body });
    }

    const clients = await clientRepository.list();
    const client = clients.find(c => c.phone === to);

    const whatsappMsg: WhatsAppMessage = {
      id: createId(),
      clientId: client?.id,
      phone: to,
      direction: 'OUTBOUND',
      messageSid,
      body: messageBody,
      templateName,
      status: 'SENT',
      createdAt: new Date(),
    };

    await whatsappMessageRepository.create(whatsappMsg);

    res.status(201).json({
      success: true,
      messageSid,
      message: 'Mensaje enviado correctamente.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    console.log('[WhatsApp Webhook] Request received');
    console.log('[WhatsApp Webhook] Headers:', JSON.stringify(req.headers, null, 2));
    console.log('[WhatsApp Webhook] Body:', req.body);
    console.log('[WhatsApp Webhook] BASE_URL:', process.env.BASE_URL);

    const shouldValidate = process.env.TWILIO_WEBHOOK_VALIDATION === 'true';

    if (shouldValidate) {
      const webhookUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/communications/webhook`;
      console.log('[WhatsApp Webhook] Validating with URL:', webhookUrl);
      
      const isValid = whatsappService.validateWebhook(
        req.headers,
        req.body,
        webhookUrl
      );

      console.log('[WhatsApp Webhook] Validation result:', isValid);

      if (!isValid) {
        throw new BusinessError('INVALID_WEBHOOK', 'Firma de Twilio inválida.');
      }
    }
    }

    const parsed = whatsappService.parseIncomingMessage(req.body);

    const clients = await clientRepository.list();
    const client = clients.find(c => c.phone === parsed.from);

    const whatsappMsg: WhatsAppMessage = {
      id: createId(),
      clientId: client?.id,
      phone: parsed.from,
      direction: 'INBOUND',
      messageSid: parsed.messageSid,
      body: parsed.body,
      status: 'DELIVERED',
      profileName: parsed.profileName,
      createdAt: new Date(),
    };

    await whatsappMessageRepository.create(whatsappMsg);

    console.log('[WhatsApp] Mensaje recibido:', parsed);

    res.status(200).json({
      success: true,
      message: 'Mensaje recibido correctamente.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/messages/:phone', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone } = req.params;
    const messages = await whatsappMessageRepository.listByPhone(phone);
    
    const sortedMessages = messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json({
      messages: sortedMessages,
      total: sortedMessages.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/status/:sid', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.status(200).json({
      success: true,
      message: 'Endpoint de status (Twilio webhooks).',
    });
  } catch (err) {
    next(err);
  }
});

export default router;
