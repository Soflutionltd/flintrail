// Instructions MCP : envoyées à tout client à la connexion, elles disent à l'agent de demander
// dans quel navigateur travailler, ou comment en connecter un.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, EXTENSION_URL, SERVER_INSTRUCTIONS } from '../dist/server.js';

test('the server sends its instructions at connection', async () => {
  const server = buildServer();
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const instructions = client.getInstructions();
  assert.equal(instructions, SERVER_INSTRUCTIONS);
  assert.match(instructions, /fl_extension/);
  assert.match(instructions, /ask the user which one/);
  assert.match(instructions, /Connected to Rocketwright/);
  // A code or link sent by e-mail: read by Rocketwright from the open mailbox, not copied by the user.
  assert.match(instructions, /use fl_mail_code \(types the code into the form\) or fl_mail_link \(opens the link in a new tab\) instead of asking the user/);
  assert.match(instructions, /never opened or restarted by Rocketwright/);
  assert.match(instructions, /fl_tabs all:true/);
  assert.match(instructions, /fl_reopen/);
  // With no browser connected, the user is given the extension's own link right away.
  assert.ok(instructions.includes(`give them its link: ${EXTENSION_URL}`));
  assert.match(EXTENSION_URL, /^https:\/\/chromewebstore\.google\.com\/detail\/rocketwright\//);
  await client.close();
  await server.close();
});
