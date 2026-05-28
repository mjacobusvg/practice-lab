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

    <!-- BAA BODY TEXT -->
    <p>This Business Associate Agreement (&ldquo;Agreement&rdquo;) is entered into between Think Beyond Practice LLC, a Washington limited liability company (&ldquo;Business Associate&rdquo;), and the individual clinician, professional practice, or healthcare entity accepting this Agreement (&ldquo;Covered Entity&rdquo;). Business Associate and Covered Entity may be referred to individually as a &ldquo;Party&rdquo; and collectively as the &ldquo;Parties.&rdquo;</p>
    <p>This Agreement is incorporated into and supplements the Terms of Service between the Parties (the &ldquo;Service Agreement&rdquo;). In the event of any conflict between this Agreement and the Service Agreement with respect to the handling of Protected Health Information, this Agreement shall control.</p>
    <p>By accepting this Agreement, Covered Entity represents that the individual accepting has the authority to bind Covered Entity to this Agreement.</p>

    <h3>1. Definitions</h3>
    <p>Capitalized terms used in this Agreement and not otherwise defined shall have the meanings given to them under the Health Insurance Portability and Accountability Act of 1996 (&ldquo;HIPAA&rdquo;), as amended by the Health Information Technology for Economic and Clinical Health Act (&ldquo;HITECH Act&rdquo;), and the regulations promulgated thereunder at 45 C.F.R. Parts 160 and 164 (collectively, the &ldquo;HIPAA Rules&rdquo;).</p>
    <p><strong>1.1</strong> &ldquo;Breach&rdquo; has the meaning given in 45 C.F.R. &sect; 164.402.</p>
    <p><strong>1.2</strong> &ldquo;Business Associate&rdquo; means Think Beyond Practice LLC, in its capacity as a business associate to Covered Entity under this Agreement.</p>
    <p><strong>1.3</strong> &ldquo;Covered Entity&rdquo; means the clinician, professional practice, or healthcare entity that has entered into this Agreement with Business Associate.</p>
    <p><strong>1.4</strong> &ldquo;Designated Record Set&rdquo; has the meaning given in 45 C.F.R. &sect; 164.501.</p>
    <p><strong>1.5</strong> &ldquo;Electronic Protected Health Information&rdquo; or &ldquo;ePHI&rdquo; has the meaning given in 45 C.F.R. &sect; 160.103, limited to information created, received, maintained, or transmitted by Business Associate on behalf of Covered Entity through the Platform.</p>
    <p><strong>1.6</strong> &ldquo;Individual&rdquo; has the meaning given in 45 C.F.R. &sect; 160.103 and includes a person who qualifies as a personal representative under 45 C.F.R. &sect; 164.502(g).</p>
    <p><strong>1.7</strong> &ldquo;Platform&rdquo; means the Think Beyond Practice software platform, including Practice Manager, Credentialing Hub, and any other current or future Platform features through which Business Associate creates, receives, maintains, or transmits PHI on behalf of Covered Entity.</p>
    <p><strong>1.8</strong> &ldquo;Protected Health Information&rdquo; or &ldquo;PHI&rdquo; has the meaning given in 45 C.F.R. &sect; 160.103, limited to information created, received, maintained, or transmitted by Business Associate from or on behalf of Covered Entity through the Platform.</p>
    <p><strong>1.9</strong> &ldquo;Required by Law&rdquo; has the meaning given in 45 C.F.R. &sect; 164.103.</p>
    <p><strong>1.10</strong> &ldquo;Secretary&rdquo; means the Secretary of the United States Department of Health and Human Services or her designee.</p>
    <p><strong>1.11</strong> &ldquo;Security Incident&rdquo; has the meaning given in 45 C.F.R. &sect; 164.304.</p>
    <p><strong>1.12</strong> &ldquo;Subcontractor&rdquo; has the meaning given in 45 C.F.R. &sect; 160.103.</p>
    <p><strong>1.13</strong> &ldquo;Unsuccessful Security Incident&rdquo; means an incident such as a &ldquo;ping&rdquo; or other unsuccessful attempt to access a network, an unsuccessful login attempt, network probe, port scan, malware that is detected and contained without harm, or similar event that, individually and in the aggregate, does not result in actual compromise of PHI.</p>

    <h3>2. Obligations and Activities of Business Associate</h3>
    <p><strong>2.1 Permitted Uses and Disclosures.</strong> Business Associate shall not use or disclose PHI other than as permitted or required by this Agreement, the Service Agreement, or as Required by Law. Specifically, Business Associate may use and disclose PHI only: (a) To perform functions, activities, and services for or on behalf of Covered Entity as described in the Service Agreement; (b) For the proper management and administration of Business Associate or to carry out the legal responsibilities of Business Associate, provided that any disclosure for such purposes is either Required by Law or made under written assurances from the recipient that the PHI will be held confidentially, used or further disclosed only as Required by Law or for the purpose for which it was disclosed, and that the recipient will notify Business Associate of any breach of confidentiality; (c) To provide data aggregation services relating to the healthcare operations of Covered Entity, if requested by Covered Entity; (d) As Required by Law.</p>
    <p><strong>2.2 Use Restrictions.</strong> Business Associate shall: (a) Not use or disclose PHI in a manner that would violate the HIPAA Rules if done by Covered Entity, except as expressly permitted under 45 C.F.R. &sect;&sect; 164.504(e)(2)(i)(A) or (B); (b) Not use or disclose PHI for marketing purposes or to sell PHI, except as permitted under HIPAA Rules and only with Covered Entity&rsquo;s written authorization; (c) Not use PHI received from or on behalf of Covered Entity to develop, train, or improve any artificial intelligence model, machine learning model, or similar system. This restriction does not prohibit Business Associate from using de-identified data, aggregated data, synthetic data, content explicitly contributed by Covered Entity under the Service Agreement&rsquo;s user-generated content provisions, or other data that does not constitute PHI for AI development purposes; (d) Limit its use, disclosure, and request of PHI to the minimum necessary to accomplish the intended purpose, in accordance with 45 C.F.R. &sect;&sect; 164.502(b) and 164.514(d).</p>
    <p><strong>2.3 Safeguards.</strong> Business Associate shall implement and maintain appropriate administrative, physical, and technical safeguards, and shall comply with the applicable provisions of Subpart C of 45 C.F.R. Part 164 with respect to ePHI, to: (a) Prevent use or disclosure of PHI other than as provided for by this Agreement; (b) Reasonably protect the confidentiality, integrity, and availability of ePHI that Business Associate creates, receives, maintains, or transmits on behalf of Covered Entity. Business Associate&rsquo;s safeguards include, without limitation: Encryption of ePHI in transit and at rest where applicable; Access controls limiting employee and Subcontractor access to PHI on a least-privilege basis; Audit logging of administrative access to systems that process PHI; Authentication controls including support for multi-factor authentication; Data minimization practices including limited retention of patient information processed through the Platform; Vendor management procedures for Subcontractors; Workforce training on HIPAA obligations; Incident response and breach notification procedures.</p>
    <p><strong>2.4 Reporting Obligations.</strong> Business Associate shall: (a) Report to Covered Entity any use or disclosure of PHI not provided for by this Agreement of which Business Associate becomes aware; (b) Report to Covered Entity any Security Incident of which Business Associate becomes aware, except that the Parties acknowledge and agree that this Section constitutes notice to Covered Entity of the regular occurrence of Unsuccessful Security Incidents, for which no further notification is required; (c) Report any Breach of unsecured PHI in accordance with Section 4 of this Agreement.</p>
    <p><strong>2.5 Subcontractors.</strong> Business Associate shall ensure that any Subcontractor that creates, receives, maintains, or transmits PHI on behalf of Business Associate agrees in writing to substantially the same restrictions, conditions, and requirements that apply to Business Associate under this Agreement. Business Associate shall maintain Business Associate Agreements with all such Subcontractors.</p>
    <p><strong>2.6 Access to PHI.</strong> The Parties acknowledge that the Platform is not designed to maintain a Designated Record Set on behalf of Covered Entity. Patient information processed through the Platform is delivered to Covered Entity, who is responsible for maintaining the Designated Record Set within Covered Entity&rsquo;s own records system. To the extent Business Associate retains any PHI in a form that constitutes part of a Designated Record Set, Business Associate shall, within thirty (30) business days of a written request from Covered Entity, provide access to such PHI.</p>
    <p><strong>2.7 Amendment of PHI.</strong> Consistent with Section 2.6, the Platform is not designed to maintain a Designated Record Set. To the extent Business Associate retains any PHI in a form that constitutes part of a Designated Record Set, Business Associate shall, within thirty (30) business days of a written request, make any amendment that Covered Entity directs.</p>
    <p><strong>2.8 Accounting of Disclosures.</strong> Business Associate shall maintain records of disclosures of PHI as required by 45 C.F.R. &sect; 164.528 and shall, within thirty (30) business days of a written request, provide an accounting of disclosures.</p>
    <p><strong>2.9 Documentation and Records.</strong> Business Associate shall make its internal practices, books, and records relating to the use and disclosure of PHI available to the Secretary for purposes of determining compliance with the HIPAA Rules.</p>
    <p><strong>2.10 Mitigation.</strong> Business Associate shall take reasonable steps to mitigate any harmful effect of a use or disclosure of PHI in violation of this Agreement.</p>
    <p><strong>2.11 Compliance with HIPAA Security Rule.</strong> Business Associate shall comply with the applicable requirements of the HIPAA Security Rule (Subpart C of 45 C.F.R. Part 164).</p>
    <p><strong>2.12 Email and Messaging Channels.</strong> The Parties acknowledge that certain Platform features may transmit PHI to Covered Entity through email or other messaging channels. Business Associate maintains a BAA with the email service provider and applies appropriate technical safeguards. Covered Entity is responsible for the security of Covered Entity&rsquo;s own email environment.</p>

    <h3>3. Obligations and Activities of Covered Entity</h3>
    <p><strong>3.1</strong> Covered Entity shall notify Business Associate of any limitation(s) in its notice of privacy practices that may affect Business Associate&rsquo;s use or disclosure of PHI.</p>
    <p><strong>3.2</strong> Covered Entity shall notify Business Associate of any changes in, or revocation of, the permission by an Individual to use or disclose PHI.</p>
    <p><strong>3.3</strong> Covered Entity shall notify Business Associate of any restriction on the use or disclosure of PHI under 45 C.F.R. &sect; 164.522.</p>
    <p><strong>3.4</strong> Covered Entity shall not request Business Associate to use or disclose PHI in any manner not permissible under the HIPAA Rules.</p>
    <p><strong>3.5 Appropriate Use of Platform.</strong> Covered Entity shall: (a) Use the Platform in accordance with the Service Agreement; (b) Submit PHI only through Platform features designed to handle PHI; (c) Obtain any required patient consents or authorizations; (d) Maintain the security of account credentials; (e) Comply with Covered Entity&rsquo;s own HIPAA obligations.</p>

    <h3>4. Breach Notification</h3>
    <p><strong>4.1</strong> Business Associate shall notify Covered Entity of any Breach of Unsecured PHI without unreasonable delay and in no case later than sixty (60) calendar days after discovery.</p>
    <p><strong>4.2</strong> The notification shall include: (a) identification of affected Individuals; (b) description of what happened; (c) types of Unsecured PHI involved; (d) steps Individuals should take; (e) what Business Associate is doing to investigate and prevent further Breaches; (f) contact information.</p>
    <p><strong>4.3</strong> Business Associate shall cooperate with Covered Entity in any investigation and notification.</p>
    <p><strong>4.4</strong> Each Party shall bear costs attributable to its own actions or omissions giving rise to a Breach.</p>

    <h3>5. Term and Termination</h3>
    <p><strong>5.1</strong> This Agreement shall be effective as of the date of acceptance and shall remain in effect until terminated or until termination of the Service Agreement.</p>
    <p><strong>5.2</strong> Either Party may terminate for material breach with thirty (30) days written notice and opportunity to cure.</p>
    <p><strong>5.3</strong> Upon termination, Business Associate shall return or destroy all PHI if feasible. The Platform processes patient information transiently and does not retain PHI for ongoing storage.</p>
    <p><strong>5.4</strong> Obligations under Sections 2.4, 2.5, 2.10, 4, 5.3, and 6 shall survive termination.</p>

    <h3>6. Miscellaneous</h3>
    <p><strong>6.1</strong> Regulatory references mean the section as in effect or as amended. <strong>6.2</strong> The Parties agree to amend this Agreement as necessary for HIPAA compliance. <strong>6.3</strong> Rights and obligations intended to survive termination shall survive. <strong>6.4</strong> Ambiguity shall be resolved in favor of HIPAA compliance. <strong>6.5</strong> No third-party beneficiaries except as required by HIPAA. <strong>6.6</strong> This Agreement controls over the Service Agreement with respect to PHI. <strong>6.7</strong> Governed by Washington state law. <strong>6.8</strong> This Agreement and the Service Agreement constitute the entire agreement. <strong>6.9</strong> If any provision is invalid, remaining provisions remain in effect. <strong>6.10</strong> Electronic acceptance has the same force as a signed original. <strong>6.11</strong> Notices to Business Associate: Think Beyond Practice LLC, 9631 N Nevada St, Suite 209, Spokane, WA 99218, privacy@thinkbeyondpractice.com.</p>

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
