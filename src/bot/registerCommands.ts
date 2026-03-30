import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { getConfig } from "../config";

async function main(): Promise<void> {
  const config = getConfig();

  const commands = [
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask the community assistant a question.")
      .addStringOption((option) =>
        option
          .setName("question")
          .setDescription("What should the bot answer?")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("daily-report")
      .setDescription("Show today's community summary."),
    new SlashCommandBuilder()
      .setName("weekly-report")
      .setDescription("Show the last 7 days of community activity."),
    new SlashCommandBuilder()
      .setName("reload-kb")
      .setDescription("Reload local and remote knowledge sources.")
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.discordToken);

  if (config.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId), {
      body: commands
    });

    console.log(`Registered guild commands for ${config.discordGuildId}.`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), {
    body: commands
  });

  console.log("Registered global commands.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
