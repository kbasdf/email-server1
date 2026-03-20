// email_server_full.js
require('dotenv').config();
const nodemailer = require('nodemailer');
const Imap = require('imap');
const dns = require('dns').promises;
const net = require('net');
const { simpleParser } = require('mailparser');

// prefer public resolvers to avoid local resolver refusal
dns.setServers(['8.8.8.8', '1.1.1.1']);

const YAHOO_EMAIL = process.env.YAHOO_EMAIL;
const YAHOO_APP_PASSWORD = process.env.YAHOO_APP_PASSWORD;
if (!YAHOO_EMAIL || !YAHOO_APP_PASSWORD) {
  console.error('Set YAHOO_EMAIL and YAHOO_APP_PASSWORD in .env');
  process.exit(1);
}

/* ---------------------------
   Nodemailer (Yahoo SMTP)
   --------------------------- */
const transporter = nodemailer.createTransport({
  host: 'smtp.mail.yahoo.com',
  port: 465,
  secure: true,
  auth: {
    user: YAHOO_EMAIL,
    pass: YAHOO_APP_PASSWORD
  },
  logger: false,
  debug: false
});

/* ---------------------------
   IMAP helper (connect, search, fetch)
   --------------------------- */
function imapConnect() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: YAHOO_EMAIL,
      password: YAHOO_APP_PASSWORD,
      host: 'imap.mail.yahoo.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once('ready', () => resolve(imap));
    imap.once('error', (err) => reject(err));
    imap.connect();
  });
}

function imapOpenInbox(imap, readOnly = true) {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', readOnly, (err, box) => {
      if (err) return reject(err);
      resolve(box);
    });
  });
}

async function fetchUnreadIds() {
  let imap;
  try {
    imap = await imapConnect();
    await imapOpenInbox(imap, true);
    return await new Promise((resolve, reject) => {
      imap.search(['UNSEEN'], (err, results) => {
        imap.end();
        if (err) return reject(err);
        resolve(results);
      });
    });
  } catch (err) {
    if (imap && imap.state !== 'disconnected') try { imap.end(); } catch(e){}
    throw err;
  }
}

/* ---------------------------
   Send test email (unique subject)
   --------------------------- */
const crypto = require('crypto');

async function sendTestEmail(to) {
  const token = `verify-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const subject = `Verification test ${token}`;
  const body = `Verification token: ${token}\nDo not reply.`;
  // create a stable string Message-ID
  const messageId = `<${token}@${YAHOO_EMAIL.split('@')[1]}>`;

  const mailOptions = {
    from: `"Verifier" <${YAHOO_EMAIL}>`,
    to,
    subject,
    text: body,
    messageId // nodemailer will use this header
  };

  const info = await transporter.sendMail(mailOptions);
  // Normalize returned id to string for later matching
  const infoId = info && info.messageId ? String(info.messageId) : messageId;
  console.log('Sent test email:', { to, subject, messageId, infoId });
  return { token, subject, messageId: String(messageId), infoId: String(infoId) };
}


/* ---------------------------
   MX/A lookup and SMTP probe
   --------------------------- */
async function verifyRecipientImproved(email, options = {}) {
  const from = options.from || YAHOO_EMAIL;
  const timeout = options.timeout || 10000;
  const parts = email.split('@');
  if (parts.length !== 2) return { status: 'invalid_email', message: 'Invalid email format' };
  const domain = parts[1];

  // 1) MX lookup
  let mxRecords = [];
  try {
    mxRecords = await dns.resolveMx(domain);
  } catch (err) {
    // try A fallback if MX fails
    try {
      const a = await dns.resolve4(domain);
      if (a && a.length) {
        // probe domain itself
        try {
          const probe = await probeMxHost(domain, email, from, timeout);
          if (probe === 'accepted') return { status: 'server_found', method: 'A_fallback', mx: domain };
          if (probe === 'rejected') return { status: 'rejected', method: 'A_fallback', mx: domain };
          return { status: 'inconclusive', method: 'A_fallback', mx: domain };
        } catch (e) {
          return { status: 'probe_unreachable', message: 'Could not connect to domain on port 25 (A fallback)', error: e.message };
        }
      } else {
        return { status: 'no_mx_no_a', message: 'No MX and no A records' };
      }
    } catch (aErr) {
      return { status: 'dns_error', message: 'DNS lookup failed for MX and A', error: aErr.message || err.message };
    }
  }

  if (!mxRecords || mxRecords.length === 0) {
    return { status: 'no_mx', message: 'No MX records found for domain' };
  }

  mxRecords.sort((a,b)=>a.priority-b.priority);
  for (const mx of mxRecords) {
    try {
      const probe = await probeMxHost(mx.exchange, email, from, timeout);
      if (probe === 'accepted') return { status: 'server_found', mx: mx.exchange };
      if (probe === 'rejected') continue;
      if (probe === 'inconclusive') continue;
    } catch (err) {
      // connection error -> try next MX
      continue;
    }
  }

  return { status: 'server_not_found_or_rejected', message: 'MX found but recipient rejected or probes inconclusive' };
}

function probeMxHost(host, email, from, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(25, host);
    let buffer = '';
    let step = 0;
    let closed = false;

    const cleanup = () => {
      if (!closed) {
        closed = true;
        try { socket.end(); } catch (e) {}
      }
    };

    const send = (line) => {
      try { socket.write(line + '\r\n'); } catch (e) {}
    };

    const onData = (data) => {
      buffer += data.toString();
      const lines = buffer.split(/\r\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const code = parseInt(line.slice(0,3));
        if (isNaN(code)) continue;

        if (step === 0 && code === 220) {
          send(`EHLO probe.local`);
          step = 1;
          continue;
        }

        if (step === 1 && code >= 250) {
          send(`MAIL FROM:<${from}>`);
          step = 2;
          continue;
        }

        if (step === 2 && code >= 250 && code < 400) {
          send(`RCPT TO:<${email}>`);
          step = 3;
          continue;
        }

        if (step === 3) {
          if (code >= 200 && code < 300) {
            send('QUIT');
            cleanup();
            return resolve('accepted');
          }
          if (code >= 500 && code < 600) {
            send('QUIT');
            cleanup();
            return resolve('rejected');
          }
          if (code >= 400 && code < 500) {
            send('QUIT');
            cleanup();
            return resolve('inconclusive');
          }
        }
      }
    };

    socket.setTimeout(timeout, () => {
      cleanup();
      reject(new Error('timeout or port 25 blocked'));
    });

    socket.on('data', onData);
    socket.on('error', (err) => {
      cleanup();
      reject(err);
    });
    socket.on('end', () => cleanup());
    socket.on('close', () => cleanup());
  });
}

/* ---------------------------
   Bounce detection (poll IMAP)
   --------------------------- */

async function searchForBounceByToken(imap, token, messageId, recipient) {
  // normalize inputs to lowercase strings
  const tokenLower = token ? String(token).toLowerCase() : '';
  const msgIdLower = messageId ? String(messageId).toLowerCase() : '';

  return new Promise((resolve, reject) => {
    imap.search(['ALL'], (err, results) => {
      if (err) return reject(err);
      if (!results || results.length === 0) return resolve(null);

      const ids = results.slice(-50);
      const f = imap.fetch(ids, { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)', 'TEXT'], struct: false });
      const matches = [];
      f.on('message', (msg) => {
        let header = '', text = '';
        msg.on('body', (stream, info) => {
          let buf = '';
          stream.on('data', (chunk) => buf += chunk.toString('utf8'));
          stream.on('end', () => {
            if (info.which === 'TEXT') text = buf;
            else header = buf;
          });
        });
        msg.once('end', () => {
          const combined = (header + '\n' + text).toLowerCase();
          const tokenFound = tokenLower && combined.includes(tokenLower);
          const msgIdFound = msgIdLower && combined.includes(msgIdLower);
          if (tokenFound || msgIdFound) {
            // optional extra check for recipient presence
            const recipientFound = !recipient || combined.includes(String(recipient).toLowerCase());
            if (recipientFound) matches.push({ header, text });
          }
        });
      });
      f.once('error', (e) => reject(e));
      f.once('end', () => resolve(matches.length ? matches : null));
    });
  });
}

async function waitForBounce(token, messageId, recipient, timeoutMs = 60000, pollInterval = 5000) {
  const endTime = Date.now() + timeoutMs;
  while (Date.now() < endTime) {
    let imap;
    try {
      imap = await imapConnect();
      await imapOpenInbox(imap, false);
      const hits = await searchForBounceByToken(imap, token, messageId, recipient);
      if (hits && hits.length) {
        imap.end();
        console.log('Bounce matched token/Message-ID. First match header snippet:', hits[0].header.slice(0,1000));
        return { bounce: true, detail: hits[0] };
      }

      // Debug: show recent headers so you can inspect what arrived
      const recent = await new Promise((resolve, reject) => {
        imap.search(['ALL'], (err, results) => {
          if (err) return reject(err);
          const ids = (results || []).slice(-10);
          if (!ids.length) return resolve([]);
          const f = imap.fetch(ids, { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)'], struct: false });
          const out = [];
          f.on('message', (msg) => {
            let header = '';
            msg.on('body', (stream) => {
              let buf = '';
              stream.on('data', (chunk) => buf += chunk.toString('utf8'));
              stream.on('end', () => header = buf);
            });
            msg.once('end', () => out.push(header));
          });
          f.once('end', () => resolve(out));
          f.once('error', (e) => reject(e));
        });
      });
      console.log('Recent headers sample:', recent.map(h => h.split('\r\n').slice(0,6).join(' | ')));

      imap.end();
    } catch (err) {
      if (imap && imap.state !== 'disconnected') try { imap.end(); } catch(e){}
      console.log('IMAP poll error (will retry):', err.message || err);
    }
    await new Promise(r => setTimeout(r, pollInterval));
  }
  return { bounce: false };
}

/* ---------------------------
   Combined flow
   --------------------------- */
async function run(recipient) {
  console.log('1) IMAP check (unread IDs)...');
  try {
    const unread = await fetchUnreadIds();
    console.log('Unread message IDs (sample):', unread.slice(0, 50));
  } catch (err) {
    console.error('IMAP error:', err.message || err);
  }

  console.log('\n2) MX/A lookup + SMTP probe verification...');
  try {
    const verification = await verifyRecipientImproved(recipient);
    console.log('Verification result:', verification);
    if (verification.status === 'server_found') {
      console.log('=> Email server found (RCPT accepted) at', verification.mx || verification.method);
    } else if (verification.status === 'probe_unreachable') {
      console.log('=> Probe unreachable (likely port 25 blocked). Will use bounce detection.');
    } else if (verification.status === 'no_mx_no_a' || verification.status === 'no_mx') {
      console.log('=> No MX/A records found for domain. Note: some MTAs accept mail via A record fallback or via submission servers.');
    } else {
      console.log('=> Verification inconclusive:', verification.message || verification);
    }
  } catch (err) {
    console.error('Verification error:', err.message || err);
  }

  console.log('\n3) Send test email and wait for bounce (short window)...');
  try {
    const { messageId, subject, info } = await sendTestEmail(recipient);
    console.log('Sent test email. Message-ID:', messageId, 'Subject:', subject);
    // Wait for bounce for up to 2 minutes
    const bounceResult = await waitForBounce(subject, 120000, 5000);
    if (bounceResult.bounce) {
      console.log('Bounce detected. Mailbox likely invalid. Detail:', bounceResult.detail && (bounceResult.detail.header || '').slice(0,200));
    } else {
      console.log('No bounce detected within timeout. Mail likely accepted by recipient server (or bounce delayed).');
    }
  } catch (err) {
    console.error('Send or bounce-check error:', err.message || err);
  }
}

/* ---------------------------
   CLI entry
   --------------------------- */
if (require.main === module) {
  const recipient = process.argv[2];
  if (!recipient) {
    console.log('Usage: node email_server_full.js recipient@example.com');
    process.exit(0);
  }
  run(recipient).then(()=> {
    console.log('\nDone.');
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  sendTestEmail,
  fetchUnreadIds,
  verifyRecipientImproved,
  probeMxHost,
  waitForBounce
};