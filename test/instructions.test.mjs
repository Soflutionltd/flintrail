// Instructions MCP : envoyées à tout client à la connexion, elles disent à l'agent de demander
// dans quel navigateur travailler, ou comment en connecter un.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, SERVER_INSTRUCTIONS } from '../dist/server.js';

test('the server sends its instructions at connection', async () => {
  const server = buildServer();
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const instructions = client.getInstructions();
  assert.equal(instructions, SERVER_INSTRUCTIONS);
  assert.match(instructions, /fl_extension/);
  assert.match(instructions, /ask the user which one/);
  assert.match(instructions, /Connected to Flintrail/);
  await client.close();
  await server.close();
});
