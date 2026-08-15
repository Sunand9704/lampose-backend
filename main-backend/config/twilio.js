const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const whatsappFrom = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

let client;
if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
} else {
  console.warn('⚠️ Twilio credentials missing in environment variables.');
}

/**
 * Normalizes phone number to E.164 and wraps in whatsapp: prefix
 */
function formatWhatsAppNumber(phone) {
  if (!phone) return null;
  let trimmed = phone.trim();
  let hasPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (!hasPlus) {
    if (digits.length === 10) {
      digits = '91' + digits; // Default region India
    }
    digits = '+' + digits;
  } else {
    digits = '+' + digits;
  }
  return `whatsapp:${digits}`;
}

/**
 * Sends approval request message to property owner
 */
async function sendVerificationMessage(ownerMobile, ownerName, propertyName) {
  if (!client) {
    console.error('❌ Twilio client not initialized.');
    return { success: false, error: 'Twilio client not initialized' };
  }

  const to = formatWhatsAppNumber(ownerMobile);
  const contentSid = process.env.TWILIO_VERIFY_CONTENT_SID || 'HX26a009a988a64b393cb612b6c16eb94f';

  try {
    const message = await client.messages.create({
      from: whatsappFrom,
      to,
      contentSid,
      contentVariables: JSON.stringify({
        '1': ownerName || 'Property Owner',
        '2': propertyName || 'your property'
      })
    });
    console.log(`📤 WhatsApp verification template sent successfully to ${to} using Content SID ${contentSid}. Message SID: ${message.sid}`);
    return { success: true, messageSid: message.sid };
  } catch (error) {
    console.error(`❌ Failed to send WhatsApp template to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sends confirmation/cancellation message to property owner
 */
async function sendConfirmationMessage(ownerMobile, isApproved) {
  if (!client) {
    console.error('❌ Twilio client not initialized.');
    return { success: false, error: 'Twilio client not initialized' };
  }

  const to = formatWhatsAppNumber(ownerMobile);
  const body = isApproved
    ? `Thanks for choosing Lampose! Your property is verified and added successfully.`
    : `Understood. The onboarding request for your property has been cancelled. Thank you.`;

  try {
    const message = await client.messages.create({
      body,
      from: whatsappFrom,
      to,
    });
    console.log(`📤 WhatsApp confirmation sent successfully to ${to}. Message SID: ${message.sid}`);
    return { success: true, messageSid: message.sid };
  } catch (error) {
    console.error(`❌ Failed to send WhatsApp confirmation to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sends approval request message to verification team member
 */
async function sendTeamVerificationMessage(verifierMobile, ownerName, ownerMobile, propertyName) {
  if (!client) {
    console.error('❌ Twilio client not initialized.');
    return { success: false, error: 'Twilio client not initialized' };
  }

  const to = formatWhatsAppNumber(verifierMobile);
  const teamContentSid = process.env.TWILIO_TEAM_CONTENT_SID;
  
  // If no team content SID is provided, fallback to owner verify SID
  const contentSid = teamContentSid || process.env.TWILIO_VERIFY_CONTENT_SID || 'HX26a009a988a64b393cb612b6c16eb94f';

  // Prepare variables based on template SID used
  const contentVariables = teamContentSid
    ? JSON.stringify({
        '1': ownerName || 'Property Owner',
        '2': ownerMobile || 'N/A',
        '3': propertyName || 'your property'
      })
    : JSON.stringify({
        '1': ownerName || 'Property Owner',
        '2': propertyName || 'your property'
      });

  try {
    const message = await client.messages.create({
      from: whatsappFrom,
      to,
      contentSid,
      contentVariables
    });
    console.log(`📤 WhatsApp verifier template sent successfully to ${to} using Content SID ${contentSid}. Message SID: ${message.sid}`);
    return { success: true, messageSid: message.sid };
  } catch (error) {
    console.error(`❌ Failed to send WhatsApp verifier template to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendVerificationMessage,
  sendConfirmationMessage,
  sendTeamVerificationMessage,
  formatWhatsAppNumber,
};
