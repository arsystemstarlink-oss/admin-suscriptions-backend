/**
 * Recupera `paymentReference` en períodos pagados mediante un reporte aprobado, para que el
 * portal vuelva a mostrar la referencia del cliente. Solo copia si la nota del período sigue
 * siendo la del reporte: si un admin la editó, podría ser interna y no se publica. Es seguro
 * repetirlo. Sin --apply solo cuenta y no modifica nada.
 *
 * Uso: npm run backfill:payment-reference            (simulación)
 *      npm run backfill:payment-reference -- --apply
 */
import dotenv from 'dotenv';
import { initializeFirebase, getFirestore } from '../src/infrastructure/firebase';

dotenv.config();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  initializeFirebase();
  const db = getFirestore();

  const reports = await db.collection('paymentReports').where('status', '==', 'APPROVED').get();
  let withoutNotes = 0;
  let edited = 0;
  let alreadySet = 0;
  let toUpdate = 0;

  for (const reportDoc of reports.docs) {
    const report = reportDoc.data();
    const reference = typeof report.notes === 'string' ? report.notes.trim() : '';
    if (!reference) {
      withoutNotes++;
      continue;
    }
    const periodRef = db.collection('billingPeriods').doc(report.billingPeriodId);
    const outcome = await db.runTransaction(async (transaction) => {
      const period = (await transaction.get(periodRef)).data();
      if (!period || period.status !== 'PAID' || period.notes !== report.notes) return 'edited';
      if (period.paymentReference) return 'alreadySet';
      if (apply) transaction.update(periodRef, { paymentReference: report.notes });
      return 'toUpdate';
    });
    if (outcome === 'edited') edited++;
    else if (outcome === 'alreadySet') alreadySet++;
    else toUpdate++;
  }

  console.log(`Reportes aprobados: ${reports.size}. Sin referencia: ${withoutNotes}.`);
  console.log(`Nota editada o período no pagado (se omiten): ${edited}. Ya tenían referencia: ${alreadySet}.`);
  console.log(apply ? `Períodos actualizados: ${toUpdate}.` : `Se actualizarían: ${toUpdate}. Simulación: usa --apply para aplicar.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', (error as Error).message);
    process.exit(1);
  });
