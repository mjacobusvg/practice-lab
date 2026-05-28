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
const { jsPDF } = require('jspdf');

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

        // ---- Generate PDF using jsPDF ----

        // ---- Generate actual PDF ----
        const pdfBuffer = generateBaaPdf({
            signerName: signerName.trim(),
            signerEmail: signerEmail.trim(),
            entityName: entityName.trim(),
            signerTitle: signerTitle.trim(),
            baaVersion,
            signedAt,
            ipAddress
        });

        // ---- Store PDF in Supabase Storage ----
        const fileName = `baa_${signerEmail.replace(/[^a-zA-Z0-9]/g, '_')}_v${baaVersion}_${Date.now()}.pdf`;
        const storagePath = `baa-signed/${fileName}`;

        const { error: storageError } = await supabase.storage
            .from('baa-documents')
            .upload(storagePath, pdfBuffer, {
                contentType: 'application/pdf',
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
// Generate PDF using jsPDF
// ============================================
// ============================================
// Generate actual PDF using jsPDF
// ============================================
function generateBaaPdf({ signerName, signerEmail, entityName, signerTitle, baaVersion, signedAt, ipAddress }) {
    const formattedDate = new Date(signedAt).toLocaleString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short'
    });

    const doc = new jsPDF({ unit: 'in', format: 'letter' });
    const pageWidth = 8.5;
    const margin = 1;
    const textWidth = pageWidth - 2 * margin;
    let y = 1;

    function addText(text, opts = {}) {
        const size = opts.size || 10;
        const style = opts.style || 'normal';
        const align = opts.align || 'left';
        doc.setFontSize(size);
        doc.setFont('helvetica', style);
        const lines = doc.splitTextToSize(text, textWidth);
        const lineHeight = size / 72 * 1.4;
        for (const line of lines) {
            if (y > 9.5) { doc.addPage(); y = 1; }
            if (align === 'center') {
                doc.text(line, pageWidth / 2, y, { align: 'center' });
            } else {
                doc.text(line, margin, y);
            }
            y += lineHeight;
        }
        y += (opts.after || 0.1);
    }

    function addSection(title) {
        if (y > 9) { doc.addPage(); y = 1; }
        y += 0.15;
        addText(title, { size: 11, style: 'bold', after: 0.1 });
    }

    addText('THINK BEYOND PRACTICE LLC', { size: 14, style: 'bold', align: 'center', after: 0.05 });
    addText('BUSINESS ASSOCIATE AGREEMENT', { size: 12, style: 'bold', align: 'center', after: 0.05 });
    addText('Version ' + baaVersion + ' | Executed electronically', { size: 8, align: 'center', after: 0.3 });

    addText('This Business Associate Agreement ("Agreement") is entered into between Think Beyond Practice LLC, a Washington limited liability company ("Business Associate"), and the individual clinician, professional practice, or healthcare entity accepting this Agreement ("Covered Entity"). Business Associate and Covered Entity may be referred to individually as a "Party" and collectively as the "Parties."');
    addText('This Agreement is incorporated into and supplements the Terms of Service between the Parties (the "Service Agreement"). In the event of any conflict between this Agreement and the Service Agreement with respect to the handling of Protected Health Information, this Agreement shall control.');
    addText('By accepting this Agreement, Covered Entity represents that the individual accepting has the authority to bind Covered Entity to this Agreement.');

    addSection('1. Definitions');
    addText('Capitalized terms used in this Agreement and not otherwise defined shall have the meanings given to them under HIPAA, the HITECH Act, and regulations at 45 C.F.R. Parts 160 and 164 (collectively, the "HIPAA Rules").');
    addText('1.1 "Breach" has the meaning given in 45 C.F.R. 164.402. 1.2 "Business Associate" means Think Beyond Practice LLC. 1.3 "Covered Entity" means the clinician, practice, or healthcare entity that entered into this Agreement. 1.4 "Designated Record Set" per 45 C.F.R. 164.501. 1.5 "ePHI" per 45 C.F.R. 160.103, limited to information through the Platform. 1.6 "Individual" per 45 C.F.R. 160.103. 1.7 "Platform" means Think Beyond Practice software platform including Practice Manager, Credentialing Hub, and other features. 1.8 "PHI" per 45 C.F.R. 160.103, limited to information through the Platform. 1.9 "Required by Law" per 45 C.F.R. 164.103. 1.10 "Secretary" means Secretary of HHS. 1.11 "Security Incident" per 45 C.F.R. 164.304. 1.12 "Subcontractor" per 45 C.F.R. 160.103. 1.13 "Unsuccessful Security Incident" means a ping, unsuccessful login, network probe, port scan, or contained malware that does not result in actual compromise of PHI.');

    addSection('2. Obligations and Activities of Business Associate');
    addText('2.1 Permitted Uses and Disclosures. Business Associate may use and disclose PHI only: (a) To perform functions for Covered Entity per the Service Agreement; (b) For proper management of Business Associate; (c) For data aggregation services; (d) As Required by Law.');
    addText('2.2 Use Restrictions. Business Associate shall not: (a) violate HIPAA Rules; (b) use PHI for marketing or sale; (c) use PHI to train AI models; (d) exceed minimum necessary use.');
    addText('2.3 Safeguards. Business Associate shall implement appropriate safeguards including encryption, access controls, audit logging, MFA, data minimization, vendor management, workforce training, and incident response.');
    addText('2.4 Reporting. Business Associate shall report unauthorized uses, Security Incidents, and Breaches. 2.5 Subcontractors shall agree to substantially the same restrictions. 2.6 Access to PHI within 30 business days of request. 2.7 Amendment of PHI within 30 business days. 2.8 Accounting of Disclosures within 30 business days. 2.9 Records available to Secretary. 2.10 Mitigation of harmful effects. 2.11 Compliance with Security Rule. 2.12 Covered Entity responsible for own email security.');

    addSection('3. Obligations of Covered Entity');
    addText('3.1-3.4 Covered Entity shall notify Business Associate of privacy practice limitations, authorization changes, PHI restrictions, and shall not request impermissible uses. 3.5 Covered Entity shall use the Platform per the Service Agreement, submit PHI only through designated features, obtain required consents, maintain account security, and comply with own HIPAA obligations.');

    addSection('4. Breach Notification');
    addText('4.1 Notify within 60 calendar days. 4.2 Include identification of affected Individuals, description, types of PHI, recommended steps, investigation actions, and contact info. 4.3 Cooperate in investigation. 4.4 Each Party bears own costs.');

    addSection('5. Term and Termination');
    addText('5.1 Effective upon acceptance until terminated or Service Agreement ends. 5.2 Either Party may terminate for material breach with 30 days notice. 5.3 Return or destroy PHI upon termination; Platform processes PHI transiently. 5.4 Sections 2.4, 2.5, 2.10, 4, 5.3, and 6 survive.');

    addSection('6. Miscellaneous');
    addText('6.1-6.11 Regulatory references as amended. Amendment for HIPAA compliance. Survival. Ambiguity resolved for compliance. No third-party beneficiaries. This Agreement controls re PHI. Washington state law. Entire agreement. Severability. Electronic acceptance valid. Notices to: Think Beyond Practice LLC, 9631 N Nevada St, Suite 209, Spokane, WA 99218.');

    if (y > 7) { doc.addPage(); y = 1; }
    y += 0.3;
    doc.setDrawColor(11, 17, 32);
    doc.setLineWidth(0.02);
    doc.line(margin, y, pageWidth - margin, y);
    y += 0.3;

    addText('ELECTRONIC SIGNATURE', { size: 12, style: 'bold', align: 'center', after: 0.25 });
    addText('COVERED ENTITY', { size: 9, style: 'bold', after: 0.1 });
    addText('Entity Name: ' + entityName, { size: 10, after: 0.05 });
    addText('Signed By: ' + signerName, { size: 10, after: 0.05 });
    addText('Title: ' + signerTitle, { size: 10, after: 0.05 });
    addText('Email: ' + signerEmail, { size: 10, after: 0.05 });
    addText('Date Signed: ' + formattedDate, { size: 10, after: 0.25 });

    addText('BUSINESS ASSOCIATE', { size: 9, style: 'bold', after: 0.1 });
    addText('Entity Name: Think Beyond Practice LLC', { size: 10, after: 0.05 });
    addText('Signed By: Michael Van Gelder, M.S., M.N., PMHNP-BC', { size: 10, after: 0.05 });
    addText('Title: Owner', { size: 10, after: 0.05 });
    addText('Date: ' + formattedDate, { size: 10, after: 0.3 });

    doc.setFillColor(245, 243, 239);
    if (y + 0.6 > 10) { doc.addPage(); y = 1; }
    doc.rect(margin, y, textWidth, 0.6, 'F');
    y += 0.15;
    addText('Electronic Signature Verification', { size: 8, style: 'bold', after: 0.02 });
    addText('Signed via Think Beyond Practice BAA signing system. IP: ' + ipAddress + ' | Timestamp: ' + signedAt + ' | Version: ' + baaVersion, { size: 7, after: 0.02 });
    addText('Valid under the ESIGN Act and Uniform Electronic Transactions Act (UETA).', { size: 7 });

    const arrayBuffer = doc.output('arraybuffer');
    return Buffer.from(arrayBuffer);
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
