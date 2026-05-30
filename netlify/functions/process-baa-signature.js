// ============================================
// process-baa-signature.js
// Netlify Function
// ============================================
const { createClient } = require('@supabase/supabase-js');
const SESv2 = require('@aws-sdk/client-sesv2');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const https = require('https');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const sesClient = new SESv2.SESv2Client({
    region: process.env.SES_AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.SES_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.SES_AWS_SECRET_ACCESS_KEY
    }
});

// Helper: send an HTML email via SES v2
async function sesSend(from, to, subject, html) {
    const command = new SESv2.SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
            Simple: {
                Subject: { Data: subject, Charset: 'UTF-8' },
                Body: { Html: { Data: html, Charset: 'UTF-8' } }
            }
        }
    });
    return sesClient.send(command);
}

// URL to the BAA template PDF stored in your repo or Supabase
const BAA_TEMPLATE_URL = 'https://thinkbeyondpractice.com/baa-template.pdf';

function fetchPdf(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    try {
        const { signerName, signerEmail, entityName, signerTitle, baaVersion, agreedAt } = JSON.parse(event.body);

        // Validate
        if (!signerName || signerName.trim().length < 2) return { statusCode: 400, body: JSON.stringify({ error: 'Full legal name is required.' }) };
        if (!signerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) return { statusCode: 400, body: JSON.stringify({ error: 'Valid email is required.' }) };
        if (!entityName || entityName.trim().length < 2) return { statusCode: 400, body: JSON.stringify({ error: 'Practice or entity name is required.' }) };
        if (!signerTitle || signerTitle.trim().length < 2) return { statusCode: 400, body: JSON.stringify({ error: 'Title is required.' }) };

        const ipAddress = event.headers['x-forwarded-for'] ? event.headers['x-forwarded-for'].split(',')[0].trim() : 'unknown';
        const signedAt = agreedAt || new Date().toISOString();

        // Check duplicate
        const { data: existing } = await supabase
            .from('baa_signatures')
            .select('id')
            .eq('member_email', signerEmail.toLowerCase().trim())
            .eq('baa_version', baaVersion)
            .maybeSingle();

        if (existing) {
            return { statusCode: 409, body: JSON.stringify({ error: 'A BAA has already been signed with this email for this version.' }) };
        }

        // ---- Generate PDF: fetch template + append signature page ----
        const templateBytes = await fetchPdf(BAA_TEMPLATE_URL);
        const templateDoc = await PDFDocument.load(templateBytes);
        
        const font = await templateDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await templateDoc.embedFont(StandardFonts.HelveticaBold);

        const formattedDate = new Date(signedAt).toLocaleString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZoneName: 'short'
        });

        // Add signature page
        const sigPage = templateDoc.addPage([612, 792]); // Letter size
        let y = 720;
        const left = 72;

        // Horizontal rule
        sigPage.drawLine({ start: { x: 72, y: y }, end: { x: 540, y: y }, thickness: 1.5, color: rgb(0.043, 0.067, 0.125) });
        y -= 30;

        // Title
        sigPage.drawText('ELECTRONIC SIGNATURE', { x: 200, y: y, size: 14, font: fontBold, color: rgb(0.043, 0.067, 0.125) });
        y -= 40;

        // Covered Entity section
        sigPage.drawText('COVERED ENTITY', { x: left, y: y, size: 10, font: fontBold, color: rgb(0.42, 0.45, 0.5) });
        y -= 25;

        const sigFields = [
            ['Entity Name', entityName.trim()],
            ['Signed By', signerName.trim()],
            ['Title', signerTitle.trim()],
            ['Email', signerEmail.trim()],
            ['Date Signed', formattedDate],
        ];

        for (const [label, value] of sigFields) {
            sigPage.drawText(label + ':', { x: left, y: y, size: 9, font: font, color: rgb(0.42, 0.45, 0.5) });
            sigPage.drawText(value, { x: left + 100, y: y, size: 10, font: fontBold, color: rgb(0.1, 0.1, 0.18) });
            y -= 20;
        }

        y -= 20;

        // Business Associate section
        sigPage.drawText('BUSINESS ASSOCIATE', { x: left, y: y, size: 10, font: fontBold, color: rgb(0.42, 0.45, 0.5) });
        y -= 25;

        const baFields = [
            ['Entity Name', 'Think Beyond Practice LLC'],
            ['Signed By', 'Michael Van Gelder, M.S., M.N., PMHNP-BC'],
            ['Title', 'Owner'],
            ['Date', formattedDate],
        ];

        for (const [label, value] of baFields) {
            sigPage.drawText(label + ':', { x: left, y: y, size: 9, font: font, color: rgb(0.42, 0.45, 0.5) });
            sigPage.drawText(value, { x: left + 100, y: y, size: 10, font: fontBold, color: rgb(0.1, 0.1, 0.18) });
            y -= 20;
        }

        y -= 30;

        // Verification block
        sigPage.drawRectangle({ x: left, y: y - 50, width: 468, height: 60, color: rgb(0.96, 0.95, 0.94) });
        y -= 10;
        sigPage.drawText('Electronic Signature Verification', { x: left + 10, y: y, size: 8, font: fontBold, color: rgb(0.1, 0.1, 0.18) });
        y -= 14;
        sigPage.drawText(`Signed via Think Beyond Practice BAA signing system.`, { x: left + 10, y: y, size: 7, font: font, color: rgb(0.42, 0.45, 0.5) });
        y -= 12;
        sigPage.drawText(`IP: ${ipAddress}  |  Timestamp: ${signedAt}  |  BAA Version: ${baaVersion}`, { x: left + 10, y: y, size: 7, font: font, color: rgb(0.42, 0.45, 0.5) });
        y -= 12;
        sigPage.drawText('Valid under the ESIGN Act and Uniform Electronic Transactions Act (UETA).', { x: left + 10, y: y, size: 7, font: font, color: rgb(0.42, 0.45, 0.5) });

        // Save merged PDF
        const pdfBytes = await templateDoc.save();
        const pdfBuffer = Buffer.from(pdfBytes);

        // ---- Store in Supabase ----
        const fileName = `baa_${signerEmail.replace(/[^a-zA-Z0-9]/g, '_')}_v${baaVersion}_${Date.now()}.pdf`;
        const storagePath = `baa-signed/${fileName}`;

        const { error: storageError } = await supabase.storage
            .from('baa-documents')
            .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });

        if (storageError) console.error('Storage error:', storageError);

        const { data: urlData } = supabase.storage.from('baa-documents').getPublicUrl(storagePath);
        const pdfUrl = urlData?.publicUrl || null;

        // ---- Write to DB ----
        const { data: record, error: dbError } = await supabase
            .from('baa_signatures')
            .insert({
                member_name: signerName.trim(),
                member_email: signerEmail.toLowerCase().trim(),
                entity_name: entityName.trim(),
                signer_title: signerTitle.trim(),
                signed_at: signedAt,
                ip_address: ipAddress,
                baa_version: baaVersion,
                pdf_storage_path: storagePath
            })
            .select().single();

        if (dbError) {
            console.error('Database error:', dbError);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to record signature.' }) };
        }

        // ---- Email member ----
        try {
            await sesSend(
                'Think Beyond Practice <michael@thinkbeyondpractice.com>',
                signerEmail.trim(),
                'Think Beyond Practice - Signed Business Associate Agreement',
                generateMemberEmail({ signerName: signerName.trim(), entityName: entityName.trim(), baaVersion, signedAt, pdfUrl })
            );
        } catch (e) { console.error('Member email error:', e); }

        // ---- Notify Michael ----
        try {
            await sesSend(
                'Think Beyond Practice <notifications@thinkbeyondpractice.com>',
                'michael@thinkbeyondpractice.com',
                `BAA Signed: ${entityName.trim()} (${signerName.trim()})`,
                `<p>New BAA signed:</p><p><b>Name:</b> ${signerName.trim()}<br><b>Email:</b> ${signerEmail.trim()}<br><b>Entity:</b> ${entityName.trim()}<br><b>Title:</b> ${signerTitle.trim()}<br><b>Version:</b> ${baaVersion}<br><b>Signed:</b> ${signedAt}<br><b>IP:</b> ${ipAddress}</p>`
            );
        } catch (e) { console.error('Notify error:', e); }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, signatureId: record.id, pdfUrl, message: 'BAA signed successfully.' })
        };

    } catch (err) {
        console.error('BAA processing error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'An unexpected error occurred. Please contact michael@thinkbeyondpractice.com.' }) };
    }
};

function generateMemberEmail({ signerName, entityName, baaVersion, signedAt, pdfUrl }) {
    const formattedDate = new Date(signedAt).toLocaleString('en-US', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    return `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a2e;">
        <div style="background: #0b1120; padding: 24px; text-align: center;">
            <h1 style="color: #e8e2d6; font-size: 18px; margin: 0;">Think <span style="color: #2aabb8;">Beyond</span> Practice</h1>
        </div>
        <div style="padding: 32px 24px;">
            <h2 style="font-size: 20px; color: #0b1120; margin-bottom: 16px;">BAA Signed Successfully</h2>
            <p>Hi ${signerName.split(' ')[0]},</p>
            <p>This confirms that the Business Associate Agreement between <strong>${entityName}</strong> and <strong>Think Beyond Practice LLC</strong> has been executed electronically.</p>
            <div style="background: #f5f3ef; padding: 16px 20px; border-radius: 6px; margin: 24px 0;">
                <p style="margin: 4px 0;"><strong>Signed by:</strong> ${signerName}</p>
                <p style="margin: 4px 0;"><strong>Entity:</strong> ${entityName}</p>
                <p style="margin: 4px 0;"><strong>Date:</strong> ${formattedDate}</p>
                <p style="margin: 4px 0;"><strong>BAA Version:</strong> ${baaVersion}</p>
            </div>
            ${pdfUrl ? `<p><a href="${pdfUrl}" style="display: inline-block; padding: 12px 24px; background: #0b1120; color: #e8e2d6; text-decoration: none; border-radius: 6px; font-weight: 600;">Download Signed BAA</a></p>` : ''}
            <p>You are now cleared to use all clinical tools on the platform. If you have any questions, message me directly on the forum or email michael@thinkbeyondpractice.com.</p>
            <p>Michael</p>
        </div>
        <div style="padding: 16px 24px; text-align: center; font-size: 12px; color: #6b7280; border-top: 1px solid #d1cdc4;">
            Think Beyond Practice LLC | thinkbeyondpractice.com
        </div>
    </div>`;
}
