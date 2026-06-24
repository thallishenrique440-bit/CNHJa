import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: any, res: any) {
  // 1. Validate Method (GET or POST)
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2. Validate Authorization (CRON_SECRET)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.error('[SyncFees] Unauthorized attempt: Invalid or missing CRON_SECRET.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[SyncFees] Starting Asaas fee sync job...');

    const asaasApiKey = process.env.ASAAS_API_KEY;
    if (!asaasApiKey) {
      console.error('[SyncFees] Error: ASAAS_API_KEY environment variable is not defined.');
      return res.status(500).json({ error: 'ASAAS_API_KEY is not defined in the server.' });
    }

    const asaasApiUrl = (process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3').replace(/\/$/, '');

    // 3. Fetch official fees from Asaas API
    console.log(`[SyncFees] Querying Asaas API fees from: ${asaasApiUrl}/myAccount/fees`);
    const asaasResponse = await fetch(`${asaasApiUrl}/myAccount/fees`, {
      method: 'GET',
      headers: {
        'access_token': asaasApiKey
      }
    });

    if (!asaasResponse.ok) {
      const errorText = await asaasResponse.text();
      console.error(`[SyncFees] Failed to fetch fees from Asaas. HTTP Status: ${asaasResponse.status}. Error: ${errorText}`);
      return res.status(502).json({ 
        error: 'Failed to retrieve fees from Asaas gateway.',
        status: asaasResponse.status,
        details: errorText
      });
    }

    const asaasData = await asaasResponse.json();
    console.log('[SyncFees] Successfully fetched fees from Asaas:', JSON.stringify(asaasData));

    // 4. Parse fees with extreme structural robustness (future-proof)
    let officialPixFeeBRL: number | undefined;
    let officialCredit1xFeePercent: number | undefined;

    if (asaasData) {
      // Parse Credit Card 1x Fee (percentage)
      if (asaasData.card && asaasData.card.creditCard && typeof asaasData.card.creditCard.fee === 'number') {
        officialCredit1xFeePercent = asaasData.card.creditCard.fee;
      } else if (asaasData.paymentMethods && asaasData.paymentMethods.creditCard) {
        if (typeof asaasData.paymentMethods.creditCard.fee === 'number') {
          officialCredit1xFeePercent = asaasData.paymentMethods.creditCard.fee;
        } else if (typeof asaasData.paymentMethods.creditCard.percentageFee === 'number') {
          officialCredit1xFeePercent = asaasData.paymentMethods.creditCard.percentageFee;
        }
      } else if (typeof asaasData.creditCardFee === 'number') {
        officialCredit1xFeePercent = asaasData.creditCardFee;
      }

      // Parse Pix Flat Fee
      if (asaasData.pix) {
        if (typeof asaasData.pix.fixedFee === 'number') {
          officialPixFeeBRL = asaasData.pix.fixedFee;
        } else if (typeof asaasData.pix.fee === 'number') {
          officialPixFeeBRL = asaasData.pix.fee;
        }
      } else if (asaasData.paymentMethods && asaasData.paymentMethods.pix) {
        if (typeof asaasData.paymentMethods.pix.fixedFee === 'number') {
          officialPixFeeBRL = asaasData.paymentMethods.pix.fixedFee;
        } else if (typeof asaasData.paymentMethods.pix.fixedValue === 'number') {
          officialPixFeeBRL = asaasData.paymentMethods.pix.fixedValue;
        }
      } else if (typeof asaasData.pixFee === 'number') {
        officialPixFeeBRL = asaasData.pixFee;
      }
    }

    // Convert flat BRL fee to cents, with auto-scaling protection
    let pixFlatFeeInCents: number | undefined;
    if (officialPixFeeBRL !== undefined) {
      if (officialPixFeeBRL < 10) {
        pixFlatFeeInCents = Math.round(officialPixFeeBRL * 100);
      } else {
        pixFlatFeeInCents = Math.round(officialPixFeeBRL);
      }
    }

    console.log(`[SyncFees] Parsed rates: PIX Flat Fee = ${pixFlatFeeInCents} cents, Credit Card 1x Fee = ${officialCredit1xFeePercent}%`);

    if (pixFlatFeeInCents === undefined && officialCredit1xFeePercent === undefined) {
      console.error('[SyncFees] Error: Could not parse PIX or Credit Card 1x rates from Asaas response.');
      return res.status(422).json({ error: 'Could not parse rates from gateway response.' });
    }

    // 5. Fetch local platform financial settings row
    const { data: dbSettings, error: dbSettingsError } = await supabaseAdmin
      .from('platform_financial_settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (dbSettingsError) {
      console.error('[SyncFees] DB Error reading settings:', dbSettingsError);
      return res.status(500).json({ error: 'Database error fetching local financial settings.' });
    }

    const nowIso = new Date().toISOString();

    // CASE A: No row exists in database yet - insert default and populate it
    if (!dbSettings) {
      console.log('[SyncFees] No platform_financial_settings row found. Creating first entry...');
      
      const insertData = {
        id: '00000000-0000-0000-0000-000000000001',
        pix_flat_fee: pixFlatFeeInCents ?? 149,
        credit_1x_fee: officialCredit1xFeePercent ?? 3.99,
        credit_2x_fee: 5.49,
        credit_3x_fee: 6.49,
        credit_4x_fee: 7.49,
        credit_5x_fee: 8.49,
        credit_6x_fee: 9.49,
        credit_7x_fee: 10.49,
        credit_8x_fee: 11.49,
        credit_9x_fee: 12.49,
        credit_10x_fee: 13.49,
        credit_11x_fee: 14.49,
        credit_12x_fee: 15.49,
        pix_last_sync: pixFlatFeeInCents !== undefined ? nowIso : null,
        credit_1x_last_sync: officialCredit1xFeePercent !== undefined ? nowIso : null,
        fee_source: 'asaas',
        updated_at: nowIso
      };

      const { error: insertError } = await supabaseAdmin
        .from('platform_financial_settings')
        .insert(insertData);

      if (insertError) {
        console.error('[SyncFees] DB Error inserting initial settings:', insertError);
        return res.status(500).json({ error: 'Database error creating default financial settings.' });
      }

      return res.status(200).json({
        success: true,
        action: 'inserted_default',
        updatedSettings: insertData
      });
    }

    // CASE B: Record exists and has fee_source = 'manual'
    // MANDATORY rule: DO NOT modify the table, do not overwrite manual configurations.
    // Log a warning if a divergence is detected.
    if (dbSettings.fee_source === 'manual') {
      console.log('[SyncFees] Protection active: fee_source is marked as "manual". Skipping DB updates.');

      const divergentPix = pixFlatFeeInCents !== undefined && dbSettings.pix_flat_fee !== pixFlatFeeInCents;
      const divergentCredit = officialCredit1xFeePercent !== undefined && Number(dbSettings.credit_1x_fee) !== officialCredit1xFeePercent;

      if (divergentPix || divergentCredit) {
        console.warn('[SyncFees] [AUDIT] WARNING: Divergence detected between manual local settings and official Asaas fees.');
        if (divergentPix) {
          console.warn(`[SyncFees] [AUDIT] PIX flat fee divergence: Local manual is ${dbSettings.pix_flat_fee} cents. Asaas official is ${pixFlatFeeInCents} cents.`);
        }
        if (divergentCredit) {
          console.warn(`[SyncFees] [AUDIT] Credit 1x fee divergence: Local manual is ${dbSettings.credit_1x_fee}%. Asaas official is ${officialCredit1xFeePercent}%.`);
        }
      } else {
        console.log('[SyncFees] Audit pass: Manual local settings match Asaas official settings perfectly.');
      }

      return res.status(200).json({
        success: true,
        updated: false,
        fee_source: 'manual',
        message: 'No changes made. fee_source is manual. Local manual configurations protected.',
        divergenceDetected: divergentPix || divergentCredit,
        localSettings: {
          pix_flat_fee: dbSettings.pix_flat_fee,
          credit_1x_fee: dbSettings.credit_1x_fee
        },
        officialSettings: {
          pix_flat_fee: pixFlatFeeInCents,
          credit_1x_fee: officialCredit1xFeePercent
        }
      });
    }

    // CASE C: Record exists and fee_source = 'asaas'
    // Update automatically PIX flat fee, Credit card 1x fee and sync timestamps.
    console.log('[SyncFees] Sourcing mode: "asaas". Updating official fees in database...');
    
    const updateData: any = {
      updated_at: nowIso
    };

    if (pixFlatFeeInCents !== undefined) {
      updateData.pix_flat_fee = pixFlatFeeInCents;
      updateData.pix_last_sync = nowIso;
    }

    if (officialCredit1xFeePercent !== undefined) {
      updateData.credit_1x_fee = officialCredit1xFeePercent;
      updateData.credit_1x_last_sync = nowIso;
    }

    const { error: updateError } = await supabaseAdmin
      .from('platform_financial_settings')
      .update(updateData)
      .eq('id', dbSettings.id);

    if (updateError) {
      console.error('[SyncFees] DB Error updating settings:', updateError);
      return res.status(500).json({ error: 'Database error updating financial settings.' });
    }

    console.log('[SyncFees] DB updated successfully with official fees.');

    return res.status(200).json({
      success: true,
      updated: true,
      fee_source: 'asaas',
      updatedFields: updateData
    });

  } catch (error: any) {
    console.error('[SyncFees] Exception in sync job:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
