#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DistributedGraphNode, type DistributedNodeConfig, type DistributedPeer } from "./distributed-node.js";
import { IdentityFileStore } from "./identity-store.js";
import { type NetworkAddress, type PublicIdentity } from "./security-transport.js";

interface NodeProcessConfig {
  id: string;
  identityFile: string;
  storageDirectory: string;
  listen: NetworkAddress;
  committee: PublicIdentity[];
  peers?: DistributedPeer[];
  checkpointEvery?: number;
}

export async function runDistributedNode(configPath: string): Promise<DistributedGraphNode> {
  const absolute = resolve(configPath);
  const config = JSON.parse(await readFile(absolute, "utf8")) as NodeProcessConfig;
  const identity = await new IdentityFileStore(resolve(config.identityFile)).loadOrCreate(config.id);
  const declared = config.committee.find((member) => member.id === identity.id);
  if (!declared) throw new Error(`Local identity ${identity.id} is absent from the configured BFT committee`);
  if (declared.fingerprint !== identity.fingerprint) throw new Error(`Local key fingerprint does not match committee membership for ${identity.id}`);
  const nodeConfig: DistributedNodeConfig = {
    identity,
    committee: config.committee,
    storageDirectory: resolve(config.storageDirectory),
    listen: config.listen,
    ...(config.peers ? { peers: config.peers } : {}),
    ...(config.checkpointEvery === undefined ? {} : { checkpointEvery: config.checkpointEvery }),
  };
  const node = new DistributedGraphNode(nodeConfig);
  const address = await node.start();
  process.stdout.write(`${JSON.stringify({ id: identity.id, fingerprint: identity.fingerprint, address })}\n`);
  const shutdown = async (): Promise<void> => {
    await node.checkpoint();
    await node.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  return node;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("Usage: node dist/v1/node-runner.js <node-config.json>\n");
    process.exit(2);
  }
  await runDistributedNode(path);
}
