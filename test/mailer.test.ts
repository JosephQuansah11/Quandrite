import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Mailer, isEmail } from '../server/mailer.ts';
import { createServer } from '../server/index.ts';
import { loadConfig } from '../server/config.ts';

const silent = { info() {}, warn() {}, error() {} };

/** A stand-in SMTP server that records what was said. */
function fakeSmtp() {
  const messages = [];
  const sockets = new Set();
  let current = [];
  let inData = false;

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // The client hangs up after QUIT: never keep the connection half-open, or
    // the test run never finishes.
    socket.on('end', () => socket.end());
    socket.setEncoding('utf8');
    socket.write('220 fake ESMTP ready\r\n');
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current.join('\r\n'));
            socket.write('250 queued\r\n');
          } else {
            current.push(line.replace(/^\.\./, '.'));
          }
        } else if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (/^AUTH LOGIN/i.test(line)) socket.write('334 VXNlcm5hbWU6\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 sender ok\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write('250 recipient ok\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          current = [];
          socket.write('354 send it\r\n');
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('235 authenticated\r\n');

        index = buffer.indexOf('\r\n');
      }
    });
  });

  return { server, messages, sockets };
}

let smtp;
let smtpPort;

before(async () => {
  smtp = fakeSmtp();
  await new Promise((resolve) => smtp.server.listen(0, '127.0.0.1', resolve));
  smtpPort = smtp.server.address().port;
});

after(async () => {
  for (const socket of smtp.sockets) socket.destroy();
  await new Promise((resolve) => smtp.server.close(resolve));
});

test('email addresses are validated before anything is sent', () => {
  assert.equal(isEmail('host@example.com'), true);
  assert.equal(isEmail('  host@example.com  '), true);
  assert.equal(isEmail('nope'), false);
  assert.equal(isEmail('a@b'), false);
  assert.equal(isEmail(''), false);
  assert.equal(isEmail(null), false);
});

test('a mailer with no transport is disabled and never throws', async () => {
  const mailer = new Mailer({ logger: silent });
  assert.equal(mailer.enabled, false);
  assert.equal(mailer.transport, null);
  const result = await mailer.send({ to: 'host@example.com', subject: 'hi', text: 'hello' });
  assert.equal(result.ok, false);
  assert.match(result.error, /not configured/);
});

test('the host password is emailed over SMTP', async () => {
  const mailer = new Mailer({
    from: 'Quandrite <studio@example.com>',
    smtpUrl: `smtp://user:secret@127.0.0.1:${smtpPort}`,
    logger: silent,
  });
  assert.equal(mailer.enabled, true);
  assert.equal(mailer.transport, 'smtp');

  const result = await mailer.sendHostPassword({
    to: 'ada@example.com',
    roomId: 'launch',
    roomName: 'Product launch',
    hostPassword: 'hostpass',
    cohostPassword: 'cohostpass',
    joinUrl: 'http://localhost:8080/?room=launch',
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.via, 'smtp');
  assert.equal(mailer.sent, 1);

  const message = smtp.messages.at(-1);
  assert.match(message, /To: ada@example\.com/);
  assert.match(message, /Subject: Quandrite host password for Product launch/);
  assert.match(message, /Host password: hostpass/);
  assert.match(message, /Co-host password: cohostpass/);
  assert.match(message, /http:\/\/localhost:8080\/\?room=launch/);
});

test('a webhook transport posts the message as JSON', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(202).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  const mailer = new Mailer({
    from: 'studio@example.com',
    webhookUrl: `http://127.0.0.1:${port}/mail`,
    logger: silent,
  });
  const result = await mailer.send({ to: 'ada@example.com', subject: 'hello', text: 'body' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.via, 'webhook');
  assert.equal(received.length, 1);
  assert.equal(received[0].to, 'ada@example.com');
  assert.equal(received[0].from, 'studio@example.com');

  await new Promise((resolve) => server.close(resolve));
});

test('a room can be created with the host password mailed to the operator', async () => {
  const config = loadConfig({
    recordingsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'quandrite-mail-')),
    publicUrl: 'http://studio.test',
  });
  const mailer = new Mailer({ smtpUrl: `smtp://user:secret@127.0.0.1:${smtpPort}`, logger: silent });
  const quandrite = createServer({ config, logger: silent, mailer });
  const address = await quandrite.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'mailed', name: 'Mailed room', hostPassword: 'hostpass', hostEmail: 'ada@example.com' }),
  });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.mail.ok, true, body.mail.error);
  assert.equal(body.credentials.hostPassword, 'hostpass');
  assert.match(smtp.messages.at(-1), /Host password: hostpass/);
  assert.match(smtp.messages.at(-1), /http:\/\/studio\.test\/\?room=mailed/);

  // The invite endpoint only mails a password the caller already knows.
  const wrong = await fetch(`${base}/api/rooms/mailed/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'guess' }),
  });
  assert.equal(wrong.status, 403);

  const right = await fetch(`${base}/api/rooms/mailed/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'hostpass', role: 'host' }),
  });
  assert.equal(right.status, 200);
  const invite = await right.json();
  assert.equal(invite.sent, true);
  assert.equal(invite.role, 'host');
  assert.match(smtp.messages.at(-1), /Host password: hostpass/);
  assert.doesNotMatch(smtp.messages.at(-1), /cohostpass/, 'only the password the caller proved is sent');

  const capabilities = await (await fetch(`${base}/api/capabilities`)).json();
  assert.equal(capabilities.mail.enabled, true);
  assert.equal(capabilities.mail.transport, 'smtp');

  await quandrite.close();
});
