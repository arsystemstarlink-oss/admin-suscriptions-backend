import { Router, Request, Response, NextFunction } from 'express';
import { whatsappService } from '../../infrastructure/whatsapp-service';
import { whatsappMessageRepository, clientRepository } from '../../infrastructure/repositories';
import { pushService } from '../../infrastructure/push-service';
import { BusinessError, WhatsAppMessage } from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import { authenticateAdmin } from '../middleware/auth';

const router = Router();

router.post('/send', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
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
    const isProduction = process.env.NODE_ENV === 'production';
    const validationDisabled = process.env.TWILIO_WEBHOOK_VALIDATION === 'false';

    if (isProduction || !validationDisabled) {
      const webhookUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/communications/webhook`;
      const isValid = whatsappService.validateWebhook(
        req.headers,
        req.body,
        webhookUrl
      );

      if (!isValid) {
        throw new BusinessError('INVALID_WEBHOOK', 'Firma de Twilio inválida.');
      }
    }

    const parsed = whatsappService.parseIncomingMessage(req.body);

    if (!parsed.from || !parsed.messageSid) {
      throw new BusinessError('INVALID_DATA', 'Payload de webhook incompleto.');
    }

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

    console.log('[WhatsApp] Mensaje inbound recibido de', parsed.from);

    pushService.sendBroadcast({
      title: 'Nuevo mensaje de WhatsApp',
      body: client
        ? `${client.firstName} ${client.lastName}`
        : parsed.profileName || parsed.from,
      data: { url: '/chats' },
    }).catch((error) => {
      console.error('[Push] Error notificando mensaje entrante:', error);
    });

    res.status(200).json({
      success: true,
      message: 'Mensaje recibido correctamente.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/messages/:phone', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
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
