import { Client, GatewayIntentBits } from "discord.js";
import { getConfig } from "../config";
import { createStateStore } from "../services/storeFactory";
import { syncHistoricalMessages } from "../services/historySync";

async function main(): Promise<void> {
  const config = getConfig();
  const store = createStateStore(config);
  await store.init();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages]
  });

  client.once("clientReady", async () => {
    try {
      const summaries = await syncHistoricalMessages(client, config, store);
      for (const summary of summaries) {
        console.log(
          `${summary.guildName} (${summary.guildId}): 同步 ${summary.messageCount} 条消息，跳过 ${summary.skippedBotMessages} 条机器人消息，跳过 ${summary.skippedEmptyMessages} 条空消息。`
        );
      }
    } finally {
      await store.close();
      client.destroy();
    }
  });

  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
