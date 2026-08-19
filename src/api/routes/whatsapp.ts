import { Router, Request, Response, NextFunction } from 'express';
import {
  whatsappService,
  resolveTwilioCredentials,
  normalizePhoneNumber,
} from '../../infrastructure/whatsapp-service';
import {
  whatsappMessageRepository,
  clientRepository,
  organizationRepository,
} from '../../infrastructure/repositories';
import { pushService } from '../../infrastructure/push-service';
import { BusinessError, WhatsAppMessage, Organization, MessageStatus } from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import { authenticateAdmin } from '../middleware/auth';
import { getAuth, requireOrganizationId, getEffectiveOrganizationId } from '../middleware/tenant';

const router = Router();

router.post('/send', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const organizationId = requireOrganizationId(req);
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

    const organization = await organizationRepository.getById(organizationId);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización no existe.');
    }

    if (!organization.active) {
      throw new BusinessError('ORGANIZATION_INACTIVE', 'La organización está desactivada.');
    }

    const credentials = resolveTwilioCredentials(organization);
    if (!credentials) {
      throw new BusinessError(
        'WHATSAPP_NOT_CONFIGURED',
        'WhatsApp (Twilio) no está configurado para esta organización.'
      );
    }

    let messageSid: string;
    let messageBody = body || '';

    if (templateName) {
      messageSid = await whatsappService.sendTemplate(
        { to, templateName, variables },
        organization
      );
    } else {
      messageSid = await whatsappService.sendMessage({ to, body }, organization);
    }

    const clients = await clientRepository.listByOrganization(organizationId);
    const client = clients.find((c) => c.phone === to);

    const whatsappMsg: WhatsAppMessage = {
      id: createId(),
      organizationId,
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

async function resolveOrganizationFromWebhook(parsedTo: string): Promise<Organization | undefined> {
  if (!parsedTo) return undefined;
  try {
    return await organizationRepository.findByTwilioPhoneNumber(normalizePhoneNumber(parsedTo));
  } catch (error) {
    console.error('[WhatsApp] Error resolviendo organización del webhook:', error);
    return undefined;
  }
}

router.post('/webhook', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = whatsappService.parseIncomingMessage(req.body);

    if (!parsed.from || !parsed.messageSid) {
      throw new BusinessError('INVALID_DATA', 'Payload de webhook incompleto.');
    }

    const organization = await resolveOrganizationFromWebhook(parsed.to);

    if (organization && !organization.active) {
      throw new BusinessError('ORGANIZATION_INACTIVE', 'La organización está desactivada.');
    }

    const isProduction = process.env.NODE_ENV === 'production';
    const validationDisabled = process.env.TWILIO_WEBHOOK_VALIDATION === 'false';

    if (isProduction || !validationDisabled) {
      const credentials = resolveTwilioCredentials(organization ?? null);
      const webhookUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/communications/webhook`;
      const isValid = whatsappService.validateWebhook(
        req.headers,
        req.body,
        webhookUrl,
        credentials?.authToken
      );

      if (!isValid) {
        throw new BusinessError('INVALID_WEBHOOK', 'Firma de Twilio inválida.');
      }
    }

    let organizationId: string | undefined = organization?.id;
    let client;

    if (organizationId) {
      const clients = await clientRepository.listByOrganization(organizationId);
      client = clients.find((c) => c.phone === parsed.from);
    } else {
      const clients = await clientRepository.list();
      client = clients.find((c) => c.phone === parsed.from);
      organizationId = client?.organizationId;
    }

    const whatsappMsg: WhatsAppMessage = {
      id: createId(),
      organizationId,
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

    console.log(
      '[WhatsApp] Mensaje inbound recibido de',
      parsed.from,
      organizationId ? `(org ${organizationId})` : '(sin organización)'
    );

    if (organizationId) {
      pushService.sendBroadcastToOrganization({
        organizationId,
        title: 'Nuevo mensaje de WhatsApp',
        body: client ? `${client.firstName} ${client.lastName}` : parsed.profileName || parsed.from,
        data: { url: '/chats' },
      }).catch((error) => {
        console.error('[Push] Error notificando mensaje entrante:', error);
      });
    } else {
      pushService.sendBroadcast({
        title: 'Nuevo mensaje de WhatsApp',
        body: parsed.profileName || parsed.from,
        data: { url: '/chats' },
      }).catch((error) => {
        console.error('[Push] Error notificando mensaje entrante:', error);
      });
    }

    res.status(200).json({
      success: true,
      message: 'Mensaje recibido correctamente.',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const conversations = await whatsappMessageRepository.listConversations(organizationId);

    conversations.sort((a, b) => b.lastMessage.createdAt.getTime() - a.lastMessage.createdAt.getTime());

    res.json({
      conversations,
      total: conversations.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/messages/:phone', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone } = req.params;
    const organizationId = getEffectiveOrganizationId(req);
    const messages = await whatsappMessageRepository.listByPhone(phone, organizationId);

    const sortedMessages = messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json({
      messages: sortedMessages,
      total: sortedMessages.length,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/messages/:phone', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone } = req.params;
    const organizationId = requireOrganizationId(req);

    const normalizedPhone = normalizePhoneNumber(phone);
    const existing = await whatsappMessageRepository.listByPhone(normalizedPhone, organizationId);

    if (existing.length === 0) {
      throw new BusinessError('NOT_FOUND', 'No se encontró un chat de WhatsApp para ese número.');
    }

    const deleted = await whatsappMessageRepository.deleteByPhone(normalizedPhone, organizationId);

    res.json({
      success: true,
      deleted,
      message: 'Chat de WhatsApp eliminado correctamente.',
    });
  } catch (err) {
    next(err);
  }
});

function mapTwilioStatus(rawStatus: string): MessageStatus | undefined {
  switch (String(rawStatus).toLowerCase()) {
    case 'queued':
    case 'sent':
      return 'SENT';
    case 'delivered':
      return 'DELIVERED';
    case 'read':
      return 'READ';
    case 'undelivered':
    case 'failed':
      return 'FAILED';
    default:
      return undefined;
  }
}

async function handleStatusCallback(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const source: any = req.method === 'GET' ? req.query : req.body;
    const rawStatus = String(source.MessageStatus || '');
    const messageSid = req.params.sid || String(source.MessageSid || '');

    if (!messageSid) {
      throw new BusinessError('INVALID_DATA', 'MessageSid es requerido.');
    }

    const message = await whatsappMessageRepository.findByMessageSid(messageSid);
    const organizationId = message?.organizationId;
    const organization = organizationId
      ? await organizationRepository.getById(organizationId)
      : undefined;

    const isProduction = process.env.NODE_ENV === 'production';
    const validationDisabled = process.env.TWILIO_WEBHOOK_VALIDATION === 'false';

    if (isProduction || !validationDisabled) {
      const credentials = resolveTwilioCredentials(organization ?? null);
      const webhookUrl = `${process.env.BASE_URL || 'http://localhost:3000'}${req.originalUrl}`;
      const isValid = whatsappService.validateWebhook(
        req.headers,
        req.body,
        webhookUrl,
        credentials?.authToken
      );

      if (!isValid) {
        throw new BusinessError('INVALID_WEBHOOK', 'Firma de Twilio inválida.');
      }
    }

    if (!message) {
      throw new BusinessError('NOT_FOUND', 'Mensaje no encontrado.');
    }

    const status = mapTwilioStatus(rawStatus);
    if (!status) {
      throw new BusinessError('INVALID_DATA', `Estado de mensaje desconocido: ${rawStatus}`);
    }

    const errorMessage =
      String(source.ErrorMessage || source.ErrorCode || '').trim().slice(0, 500) || undefined;

    await whatsappMessageRepository.updateStatusByMessageSid(messageSid, status, errorMessage);

    res.status(200).json({ success: true });
  } catch (err) {
    next(err);
  }
}

router.get('/status/:sid', handleStatusCallback);
router.post('/status/:sid', handleStatusCallback);
router.get('/status', handleStatusCallback);
router.post('/status', handleStatusCallback);

export default router;
