// ============================================
// process-baa-signature.js
// Netlify Function
// ============================================
// Handles BAA signing:
// 1. Validates input
// 2. Writes signature record to Supabase (baa_signatures table)
// 3. Generates signed BAA PDF
// 4. Stores PDF in Supabase Storage
// 5. Sends copy to member via Resend
// 6. Notifies Michael
// ============================================

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

// Initialize clients
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);
const resend = new Resend(process.env.RESEND_API_KEY);

exports.handler = async (event) => {
    // Only POST
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const {
            signerName,
            signerEmail,
            entityName,
            signerTitle,
            baaVersion,
            agreedAt
        } = JSON.parse(event.body);

        // ---- Validate input ----
        if (!signerName || signerName.trim().length < 2) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Full legal name is required.' }) };
        }
        if (!signerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Valid email is required.' }) };
        }
        if (!entityName || entityName.trim().length < 2) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Practice or entity name is required.' }) };
        }
        if (!signerTitle || signerTitle.trim().length < 2) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Title is required.' }) };
        }

        // ---- Get IP address ----
        const ipAddress = event.headers['x-forwarded-for']
            ? event.headers['x-forwarded-for'].split(',')[0].trim()
            : event.headers['client-ip'] || 'unknown';

        const signedAt = agreedAt || new Date().toISOString();

        // ---- Check for duplicate signature ----
        const { data: existing } = await supabase
            .from('baa_signatures')
            .select('id')
            .eq('member_email', signerEmail.toLowerCase().trim())
            .eq('baa_version', baaVersion)
            .maybeSingle();

        if (existing) {
            return {
                statusCode: 409,
                body: JSON.stringify({
                    error: 'A BAA has already been signed with this email address for this version. If you need to re-sign, please contact michael@thinkbeyondpractice.com.'
                })
            };
        }

        // ---- Generate PDF ----
        // Using a simple HTML-to-text approach for the PDF content.
        // The PDF is generated server-side using the BAA text + signature block.
        // For production, you could use puppeteer, @react-pdf/renderer, or jsPDF on the server.
        // Below is a simplified approach that creates a text-based PDF record.

        const pdfContent = generateBaaPdfContent({
            signerName: signerName.trim(),
            signerEmail: signerEmail.trim(),
            entityName: entityName.trim(),
            signerTitle: signerTitle.trim(),
            baaVersion,
            signedAt,
            ipAddress
        });

        // ---- Store PDF in Supabase Storage ----
        const fileName = `baa_${signerEmail.replace(/[^a-zA-Z0-9]/g, '_')}_v${baaVersion}_${Date.now()}.html`;
        const storagePath = `baa-signed/${fileName}`;

        const { error: storageError } = await supabase.storage
            .from('baa-documents')
            .upload(storagePath, Buffer.from(pdfContent), {
                contentType: 'text/html',
                upsert: false
            });

        if (storageError) {
            console.error('Storage error:', storageError);
            // Non-fatal: continue even if storage fails
        }

        // Get public URL for download
        const { data: urlData } = supabase.storage
            .from('baa-documents')
            .getPublicUrl(storagePath);

        const pdfUrl = urlData?.publicUrl || null;

        // ---- Write to Supabase ----
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
            .select()
            .single();

        if (dbError) {
            console.error('Database error:', dbError);
            return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Failed to record signature. Please try again.' })
            };
        }

        // ---- Send email to member ----
        try {
            await resend.emails.send({
                from: 'Think Beyond Practice <michael@thinkbeyondpractice.com>',
                to: signerEmail.trim(),
                subject: 'Think Beyond Practice - Signed Business Associate Agreement',
                html: generateMemberEmail({
                    signerName: signerName.trim(),
                    entityName: entityName.trim(),
                    baaVersion,
                    signedAt,
                    pdfUrl
                })
            });
        } catch (emailErr) {
            console.error('Member email error:', emailErr);
            // Non-fatal: signature is recorded even if email fails
        }

        // ---- Notify Michael ----
        try {
            await resend.emails.send({
                from: 'Think Beyond Practice <notifications@thinkbeyondpractice.com>',
                to: 'michael@thinkbeyondpractice.com',
                subject: `BAA Signed: ${entityName.trim()} (${signerName.trim()})`,
                html: `
                    <p>New BAA signature received:</p>
                    <ul>
                        <li><strong>Name:</strong> ${signerName.trim()}</li>
                        <li><strong>Email:</strong> ${signerEmail.trim()}</li>
                        <li><strong>Entity:</strong> ${entityName.trim()}</li>
                        <li><strong>Title:</strong> ${signerTitle.trim()}</li>
                        <li><strong>Version:</strong> ${baaVersion}</li>
                        <li><strong>Signed at:</strong> ${signedAt}</li>
                        <li><strong>IP:</strong> ${ipAddress}</li>
                    </ul>
                `
            });
        } catch (notifyErr) {
            console.error('Notification email error:', notifyErr);
            // Non-fatal
        }

        // ---- Return success ----
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                signatureId: record.id,
                pdfUrl: pdfUrl,
                message: 'BAA signed successfully.'
            })
        };

    } catch (err) {
        console.error('BAA processing error:', err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'An unexpected error occurred. Please try again or contact michael@thinkbeyondpractice.com.' })
        };
    }
};

// ============================================
// Generate BAA PDF content (HTML format for storage/download)
// Replace with proper PDF generation (puppeteer, jsPDF) for production
// ============================================
function generateBaaPdfContent({ signerName, signerEmail, entityName, signerTitle, baaVersion, signedAt, ipAddress }) {
    const formattedDate = new Date(signedAt).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short'
    });

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Business Associate Agreement - ${entityName}</title>
    <style>
        body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #1a1a2e; line-height: 1.7; font-size: 14px; }
        h1 { font-size: 18px; text-align: center; margin-bottom: 4px; }
        h2 { font-size: 16px; text-align: center; margin-bottom: 24px; }
        h3 { font-size: 14px; margin: 20px 0 8px; }
        .signature-block { margin-top: 48px; border-top: 2px solid #0b1120; padding-top: 24px; }
        .signature-block h3 { text-align: center; margin-bottom: 24px; }
        .sig-row { display: flex; justify-content: space-between; margin-bottom: 16px; }
        .sig-field { width: 48%; }
        .sig-label { font-size: 12px; color: #6b7280; margin-bottom: 4px; }
        .sig-value { font-size: 14px; font-weight: bold; padding-bottom: 4px; border-bottom: 1px solid #d1cdc4; }
        .verification { margin-top: 32px; padding: 16px; background: #f5f3ef; border-radius: 4px; font-size: 12px; color: #6b7280; }
        .verification strong { color: #1a1a2e; }
        .header-meta { text-align: center; color: #6b7280; font-size: 12px; margin-bottom: 32px; }
    </style>
</head>
<body>
    <h1>THINK BEYOND PRACTICE LLC</h1>
    <h2>BUSINESS ASSOCIATE AGREEMENT</h2>
    <div class="header-meta">Version ${baaVersion} | Executed electronically</div>

    <!-- BAA BODY TEXT GOES HERE -->
    <!-- When Joel's final draft is ready, insert the full BAA text here -->
    <p><em>[Full BAA text included in executed version]</em></p>

    <div class="signature-block">
        <h3>ELECTRONIC SIGNATURE</h3>

        <div style="margin-bottom: 24px;">
            <div class="sig-label">COVERED ENTITY</div>
        </div>

        <div class="sig-row">
            <div class="sig-field">
                <div class="sig-label">Entity Name</div>
                <div class="sig-value">${entityName}</div>
            </div>
            <div class="sig-field">
                <div class="sig-label">Signed By</div>
                <div class="sig-value">${signerName}</div>
            </div>
        </div>

        <div class="sig-row">
            <div class="sig-field">
                <div class="sig-label">Title</div>
                <div class="sig-value">${signerTitle}</div>
            </div>
            <div class="sig-field">
                <div class="sig-label">Email</div>
                <div class="sig-value">${signerEmail}</div>
            </div>
        </div>

        <div class="sig-row">
            <div class="sig-field">
                <div class="sig-label">Date Signed</div>
                <div class="sig-value">${formattedDate}</div>
            </div>
        </div>

        <div style="margin-top: 32px; margin-bottom: 24px;">
            <div class="sig-label">BUSINESS ASSOCIATE</div>
        </div>

        <div class="sig-row">
            <div class="sig-field">
                <div class="sig-label">Entity Name</div>
                <div class="sig-value">Think Beyond Practice LLC</div>
            </div>
            <div class="sig-field">
                <div class="sig-label">Signed By</div>
                <div class="sig-value">Michael Van Gelder, M.S., M.N., PMHNP-BC</div>
            </div>
        </div>

        <div class="sig-row">
            <div class="sig-field">
                <div class="sig-label">Title</div>
                <div class="sig-value">Owner</div>
            </div>
            <div class="sig-field">
                <div class="sig-label">Date</div>
                <div class="sig-value">${formattedDate}</div>
            </div>
        </div>
    </div>

    <div class="verification">
        <strong>Electronic Signature Verification</strong><br>
        This document was signed electronically via the Think Beyond Practice BAA signing system.<br>
        Signature ID: Will be assigned upon database record creation<br>
        IP Address: ${ipAddress}<br>
        Timestamp: ${signedAt}<br>
        BAA Version: ${baaVersion}<br>
        This electronic signature is valid under the Electronic Signatures in Global and National Commerce Act (ESIGN Act) and the Uniform Electronic Transactions Act (UETA).
    </div>
</body>
</html>`;
}

// ============================================
// Generate member confirmation email
// ============================================
function generateMemberEmail({ signerName, entityName, baaVersion, signedAt, pdfUrl }) {
    const formattedDate = new Date(signedAt).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    });

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

            <p>A copy of this signed BAA is also available in your Credentialing Hub Vault on the platform.</p>

            <p>You're now cleared to use all clinical tools on the platform. If you have any questions, message me directly on the forum or email michael@thinkbeyondpractice.com.</p>

            <p>Michael</p>
        </div>

        <div style="padding: 16px 24px; text-align: center; font-size: 12px; color: #6b7280; border-top: 1px solid #d1cdc4;">
            Think Beyond Practice LLC | thinkbeyondpractice.com
        </div>
    </div>`;
}
