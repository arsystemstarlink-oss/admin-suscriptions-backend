import dotenv from 'dotenv';
import type { Query } from 'firebase-admin/firestore';
import { initializeFirebase, getFirestore } from '../src/infrastructure/firebase';
import { addOrganizationBillingMonths } from '../src/domain/business-plan';
import {
  getNextBillingDayAfter,
  getNextBillingPeriodEnd,
} from '../src/domain/business-rules';
import { normalizePhoneToE164, normalizeVenezuelanPhoneDigits } from '../src/domain/phone';

dotenv.config();

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value && 'toDate' in value) {
    return (value as { toDate: () => Date }).toDate();
  }
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fmt(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : '-';
}

async function normalizePhones(apply: boolean, organizationId?: string): Promise<void> {
  const db = getFirestore();
  let query: Query = db.collection('clients');
  if (organizationId) query = query.where('organizationId', '==', organizationId);
  const snapshot = await query.get();

  const pending: Array<{ id: string; before: string; after: string }> = [];
  const invalid: Array<{ id: string; phone: string }> = [];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const phone = String(data.phone ?? '');
    try {
      const normalized = normalizePhoneToE164(phone);
      if (normalized !== phone) {
        pending.push({ id: doc.id, before: phone, after: normalized });
      }
    } catch {
      invalid.push({ id: doc.id, phone });
    }
  }

  console.log(`[phones] ${snapshot.size} clientes revisados; ${pending.length} a normalizar; ${invalid.length} inválidos.`);
  for (const item of pending.slice(0, 50)) {
    console.log(`  - ${item.id}: "${item.before}" -> "${item.after}" (${normalizeVenezuelanPhoneDigits(item.after)})`);
  }
  if (pending.length > 50) console.log(`  ... y ${pending.length - 50} más.`);
  for (const item of invalid.slice(0, 50)) {
    console.log(`  ! ${item.id}: teléfono inválido "${item.phone}" (requiere corrección manual)`);
  }

  if (!apply) return;

  for (let index = 0; index < pending.length; index += 400) {
    const batch = db.batch();
    for (const item of pending.slice(index, index + 400)) {
      batch.update(db.collection('clients').doc(item.id), { phone: item.after });
    }
    await batch.commit();
  }
  console.log(`[phones] ${pending.length} teléfonos normalizados.`);
}

async function auditSubscriptions(organizationId?: string): Promise<void> {
  const db = getFirestore();
  let query: Query = db.collection('subscriptions');
  if (organizationId) query = query.where('organizationId', '==', organizationId);
  const subscriptions = await query.get();

  const issues: Array<{
    subscriptionId: string;
    activationDate: Date;
    billingDay: number;
    gapOrOverlap: string[];
    misalignedPaid: string[];
    firstPeriodMismatch: boolean;
  }> = [];

  for (const doc of subscriptions.docs) {
    const sub = doc.data();
    const activationDate = toDate(sub.activationDate);
    const billingDay = Number(sub.billingDay);
    if (!activationDate || !Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) {
      continue;
    }

    const periodsSnapshot = await db
      .collection('billingPeriods')
      .where('subscriptionId', '==', doc.id)
      .get();
    if (periodsSnapshot.empty) continue;

    const periods = periodsSnapshot.docs
      .map((periodDoc) => {
        const data = periodDoc.data();
        return {
          id: periodDoc.id,
          status: String(data.status ?? ''),
          startDate: toDate(data.startDate),
          endDate: toDate(data.endDate),
        };
      })
      .filter((period) => period.startDate && period.endDate)
      .sort((a, b) => a.startDate!.getTime() - b.startDate!.getTime());

    if (periods.length === 0) continue;

    const expected: Array<{ start: Date; end: Date }> = [];
    let expectedStart = new Date(activationDate);
    let expectedEnd = getNextBillingDayAfter(expectedStart, billingDay);
    expected.push({ start: expectedStart, end: expectedEnd });
    for (let index = 0; index < 120; index++) {
      expectedStart = expectedEnd;
      expectedEnd = getNextBillingPeriodEnd(expectedStart, billingDay);
      expected.push({ start: expectedStart, end: expectedEnd });
    }

    const gapOrOverlap: string[] = [];
    for (let index = 1; index < periods.length; index++) {
      const previous = periods[index - 1];
      const current = periods[index];
      if (current.startDate!.getTime() !== previous.endDate!.getTime()) {
        gapOrOverlap.push(
          `${previous.id} termina ${fmt(previous.endDate)} y ${current.id} inicia ${fmt(current.startDate)}`
        );
      }
    }

    const misalignedPaid = periods
      .filter((period) => period.status === 'PAID')
      .filter(
        (period) =>
          !expected.some(
            (candidate) =>
              candidate.start.getTime() === period.startDate!.getTime() &&
              candidate.end.getTime() === period.endDate!.getTime()
          )
      )
      .map(
        (period) =>
          `${period.id} (${fmt(period.startDate)} a ${fmt(period.endDate)}) no encaja en el ciclo anclado al día ${billingDay}`
      );

    const firstPeriod = periods[0];
    const firstPeriodMismatch =
      firstPeriod.startDate!.getTime() !== activationDate.getTime() ||
      firstPeriod.endDate!.getTime() !== getNextBillingDayAfter(activationDate, billingDay).getTime();

    if (gapOrOverlap.length || misalignedPaid.length || firstPeriodMismatch) {
      issues.push({
        subscriptionId: doc.id,
        activationDate,
        billingDay,
        gapOrOverlap,
        misalignedPaid,
        firstPeriodMismatch,
      });
    }
  }

  console.log(`[subscriptions] ${subscriptions.size} suscripciones revisadas; ${issues.length} con inconsistencias.`);
  for (const issue of issues.slice(0, 100)) {
    console.log(
      `  - ${issue.subscriptionId} activación=${fmt(issue.activationDate)} billingDay=${issue.billingDay}`
    );
    if (issue.firstPeriodMismatch) {
      console.log('    - primer período no coincide con la activación o con el siguiente día de corte');
    }
    for (const item of issue.gapOrOverlap) console.log(`    - hueco/solape: ${item}`);
    for (const item of issue.misalignedPaid) console.log(`    - pago histórico no asignado: ${item}`);
  }
  if (issues.length > 100) console.log(`  ... y ${issues.length - 100} más.`);
}

async function auditOrganizationDates(organizationId?: string): Promise<void> {
  const db = getFirestore();
  const organizations = organizationId
    ? [(await db.collection('organizations').doc(organizationId).get())].filter((doc) => doc.exists)
    : (await db.collection('organizations').get()).docs;
  const now = new Date();
  const issues: string[] = [];

  for (const doc of organizations) {
    const data = doc.data() ?? {};
    const planStatus = String(data.planStatus ?? '');
    const planExpiresAt = toDate(data.planExpiresAt);
    const trialEndsAt = toDate(data.trialEndsAt);
    const billingDay = Number.isInteger(data.billingDay) ? Number(data.billingDay) : null;

    if (planStatus === 'activo' && (!planExpiresAt || planExpiresAt.getTime() <= now.getTime())) {
      issues.push(`${doc.id}: planStatus=activo sin vencimiento futuro (${fmt(planExpiresAt)})`);
    }
    if (planStatus === 'prueba' && (!trialEndsAt || trialEndsAt.getTime() <= now.getTime())) {
      issues.push(`${doc.id}: planStatus=prueba sin prueba futura (${fmt(trialEndsAt)})`);
    }
    if (billingDay !== null) {
      const cap = addOrganizationBillingMonths(now, 12, billingDay);
      if (planExpiresAt && planExpiresAt.getTime() > cap.getTime()) {
        issues.push(`${doc.id}: planExpiresAt ${fmt(planExpiresAt)} supera el tope prepago ${fmt(cap)}`);
      }
    }
  }

  console.log(`[organizations] ${organizations.length} organizaciones revisadas; ${issues.length} con fechas inconsistentes.`);
  for (const issue of issues.slice(0, 100)) console.log(`  - ${issue}`);
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const orgArg = process.argv.find((arg) => arg.startsWith('--org='));
  const organizationId = orgArg?.slice('--org='.length);

  console.log(
    `[migrate:business-rules] modo ${apply ? 'APPLY (escribe teléfonos)' : 'DRY-RUN (solo reporte)'}${organizationId ? ` org=${organizationId}` : ''}`
  );

  initializeFirebase();
  await normalizePhones(apply, organizationId);
  await auditSubscriptions(organizationId);
  await auditOrganizationDates(organizationId);

  console.log('[migrate:business-rules] listo. Las inconsistencias de períodos y fechas son solo reportadas; corrígelas manualmente antes de migrar datos.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error en migrate:business-rules:', error);
    process.exit(1);
  });
