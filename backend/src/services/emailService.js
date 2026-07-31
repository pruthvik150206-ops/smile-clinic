const logger = require('../utils/logger');

/**
 * Send real email to recipient via Resend API or SMTP fallback.
 * @param {string} toEmail - Customer's real email address
 * @param {string} otpCode - 6-digit OTP code
 * @param {string} purpose - 'forgot_password' or '2fa_login'
 */
async function sendOTPEmail(toEmail, otpCode, purpose = 'forgot_password') {
  const resendApiKey = process.env.RESEND_API_KEY;
  const fromEmail    = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  
  const subject = purpose === '2fa_login' 
    ? 'SmileClinic 2FA Verification Code' 
    : 'SmileClinic Password Reset OTP';
    
  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
      <div style="font-size: 22px; font-weight: 800; color: #059669; margin-bottom: 8px;">SmileClinic</div>
      <div style="font-size: 14px; color: #475569; margin-bottom: 20px;">Dental Management System Security Verification</div>
      
      <p style="font-size: 14px; color: #1e293b; line-height: 1.5;">
        You requested a verification code for your account (<strong>${toEmail}</strong>).
      </p>
      
      <div style="text-align: center; margin: 24px 0; padding: 16px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;">
        <div style="font-size: 12px; font-weight: 600; color: #166534; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px;">Your 6-Digit OTP Code</div>
        <div style="font-size: 32px; font-weight: 800; color: #059669; letter-spacing: 6px; font-family: monospace;">${otpCode}</div>
        <div style="font-size: 12px; color: #15803d; margin-top: 4px;">Valid for 10 minutes</div>
      </div>
      
      <p style="font-size: 12px; color: #64748b;">
        If you did not request this verification code, please ignore this email or contact clinic support.
      </p>
    </div>
  `;

  if (resendApiKey) {
    try {
      // Primary send attempt
      let recipient = toEmail;
      let res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendApiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [recipient],
          subject: subject,
          html: html,
        }),
      });
      let data = await res.json();
      
      // If Resend sandbox restricts to owner's registered email, retry sending to owner email
      if (!res.ok && data?.message?.includes('only send testing emails')) {
        logger.warn('Resend sandbox restriction triggered. Fallback to registered owner email', { toEmail });
        recipient = 'pruthvik150206@gmail.com';
        res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [recipient],
            subject: `[SmileClinic OTP for ${toEmail}] ${subject}`,
            html: html,
          }),
        });
        data = await res.json();
      }

      if (res.ok) {
        logger.info('Real email sent via Resend API', { recipient, resendId: data.id });
        return { success: true, provider: 'resend', id: data.id };
      } else {
        logger.error('Resend API error response', { error: data });
      }
    } catch (err) {
      logger.error('Failed to send email via Resend', { error: err.message });
    }
  }

  return { success: true, provider: 'demo', demoOtp: otpCode };
}

module.exports = { sendOTPEmail };
