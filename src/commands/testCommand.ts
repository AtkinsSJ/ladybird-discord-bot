/*
 * Copyright (c) 2024, the SerenityOS & Ladybird developers.
 * Copyright (c) 2024, versecafe
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

import { EmbedBuilder, ChatInputCommandInteraction, SlashCommandBuilder, Client } from "discord.js";
import axios from "axios";
import { getLadybird, getMakemore, getSadCaret } from "@/util/emoji";
import Command from "./command";
import githubAPI from "@/apis/githubAPI";

/* eslint-disable camelcase */
interface Result {
  commit_timestamp: number;
  run_timestamp: number;
  versions: { serenity: string } & Record<string, string>;
  tests: {
    [name: string]: {
      duration: number;
      results: {
        [label: string]: number;
      };
    };
  };
}
/* eslint-enable camelcase */

interface TestVariant {
  description: string;
  url: string;
  nameForCommitError: string;
}

const variants: Record<string, TestVariant> = {
  test262: {
    description: "Display LibJS test262 results",
    url: "https://github.com/LadybirdBrowser/libjs-data/raw/master/test262/results.json",
    nameForCommitError: "test262",
  },
  testwasm: {
    description: "Display Wasm spec test results",
    url: "https://github.com/LadybirdBrowser/libjs-data/raw/master/wasm/results.json",
    nameForCommitError: "Wasm spec tests",
  },
};

export class TestCommand extends Command {
  override data() {
    return Object.entries(variants).map(([name, { description }]) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .addStringOption(commit =>
          commit.setName("commit").setDescription("The commit to use the results from")
        )
        .addStringOption(labels =>
          labels.setName("labels").setDescription("Print the meaning of label emojis").setChoices({
            name: "labels",
            value: "labels",
          })
        )
        .toJSON()
    );
  }

  override async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const variant = variants[interaction.commandName];

    const response = await axios.get<Result[]>(variant.url);

    const results: Result[] = response.data;
    let result: Result = results[results.length - 1];
    let previousResult: Result = results[results.length - 2];

    if (interaction.options.getString("labels") === "labels") {
      const lines = new Array<string>();

      for (const label in Object.values(result.tests)[0].results) {
        lines.push(`${await TestCommand.statusIconForLabel(interaction.client, label)}: ${label}`);
      }

      await interaction.reply({
        ephemeral: true,
        embeds: [new EmbedBuilder().setDescription(lines.join("\n"))],
      });
      return;
    }

    const commit = interaction.options.getString("commit");

    if (commit) {
      let foundCommit = false;

      for (let i = 0; i < results.length; i++) {
        if (results[i].versions.serenity.startsWith(commit)) {
          result = results[i];
          previousResult = results[i - 1];

          foundCommit = true;

          break;
        }
      }

      if (!foundCommit) {
        const sadcaret = await getSadCaret(interaction);

        await interaction.reply({
          ephemeral: true,
          embeds: [
            new EmbedBuilder()
              .setTitle("Not found")
              .setDescription(
                `Could not find a commit that ran ${
                  variant.nameForCommitError
                } matching '${commit}' ${sadcaret ?? ":^("}`
              ),
          ],
        });
        return;
      }
    }

    await interaction.reply({
      embeds: [
        await TestCommand.embedForResult(interaction.client, variant, result, previousResult),
      ],
    });
  }

  static repositoryUrlByName = new Map<string, string>([
    ["ladybird", "https://github.com/LadybirdBrowser/ladybird/"],
    ["libjs-test262", "https://github.com/LadybirdBrowser/libjs-test262/"],
    ["test262", "https://github.com/tc39/test262/"],
    ["test262-parser-tests", "https://github.com/tc39/test262-parser-tests/"],
  ]);

  static async statusIconForLabel(client: Client, label: string): Promise<string> {
    switch (label) {
      case "total":
        return "🧪";
      case "passed":
        return "✅";
      case "failed":
        return "❌";
      case "skipped":
        return "⚠️";
      case "metadata_error":
        return "📄";
      case "harness_error":
        return "⚙️";
      case "timeout_error":
        return "💀";
      case "process_error":
        return "💥️";
      case "runner_exception":
        return "🐍";
      case "todo_error":
        return "📝";
      case "percentage_passing":
        return (await getLadybird(client))?.toString() ?? label;
      default:
        return label;
    }
  }

  static async embedForResult(
    client: Client,
    variant: TestVariant,
    result: Result,
    previousResult?: Result
  ): Promise<EmbedBuilder> {
    const commit = await githubAPI.searchCommit(result.versions.serenity);

    if (commit == null) {
      const sadcaret = await getSadCaret(client);

      return new EmbedBuilder()
        .setTitle("Error")
        .setDescription(
          `Could not fetch the matching commit ('${result.versions.serenity}') for the ${
            variant.nameForCommitError
          } run from github ${sadcaret ?? ":^("}`
        );
    }

    const description = Object.entries(result.versions)
      .map(([repository, commitHash]) => {
        if (repository == "serenity") repository = "ladybird";
        const treeUrl = TestCommand.repositoryUrlByName.get(repository);
        const shortCommitHash = commitHash.substring(0, 7);

        if (treeUrl) return `${repository}: [${shortCommitHash}](${treeUrl}tree/${commitHash})`;

        return `${repository}: ${shortCommitHash}`;
      })
      .join("\n");

    const embed = new EmbedBuilder()
      .setAuthor({
        name: commit.author ? commit.author.login : commit.commit.author.name,
        url: commit.author?.html_url,
        iconURL: commit.author?.avatar_url,
      })
      .setTitle(commit.commit.message.split("\n")[0])
      .setDescription(description)
      .setTimestamp(new Date(result.run_timestamp * 1000))
      .setFooter({ text: "Tests started" });

    for (const [name, test] of Object.entries(result.tests)) {
      const previousTest = previousResult?.tests[name];

      const fields = new Array<string>();

      const percentage = test.results["passed"] / (test.results["total"] / 100);
      const previousPercentage = previousTest
        ? previousTest?.results["passed"] / (previousTest?.results["total"] / 100)
        : 0;
      const percentageDifference = (percentage - previousPercentage).toFixed(2);

      const libjsEmoji = await TestCommand.statusIconForLabel(client, "percentage_passing");

      if (percentageDifference !== "0.00" && percentageDifference !== "-0.00") {
        fields.push(
          `${libjsEmoji} ${percentage.toFixed(2)}% (${
            percentageDifference.startsWith("-") ? "" : "+"
          }${percentageDifference}) `
        );
      } else {
        fields.push(`${libjsEmoji} ${percentage.toFixed(2)}%`);
      }

      for (const [label, value] of Object.entries(test.results)) {
        const previousValue = previousTest?.results[label] ?? 0;
        let icon = await TestCommand.statusIconForLabel(client, label);

        if (previousValue - value !== 0) {
          const difference = value - previousValue;

          // NOTE: Show :makemore: for the number of tests in case they increased.
          if (label === "total" && difference > 0) {
            const makemore = await getMakemore(client);

            if (makemore) icon = makemore.toString();
          }

          fields.push(`${icon} ${value} (${difference > 0 ? "+" : ""}${difference})`);

          continue;
        }

        fields.push(`${icon} ${value}`);
      }

      if (previousTest) {
        for (const [label, value] of Object.entries(previousTest.results).filter(
          ([label]) => !(label in test.results)
        )) {
          const icon = await TestCommand.statusIconForLabel(client, label);

          fields.push(`${icon} 0 (-${value})`);
        }
      }

      const previousDuration = previousTest?.duration ?? 0;
      const durationLabel = `${test.duration.toFixed(2)}s`;
      if (previousDuration - test.duration !== 0) {
        const difference = test.duration - previousDuration;
        const differenceSign = difference > 0 ? "+" : "";
        const differenceLabel = `${differenceSign}${difference.toFixed(2)}s`;
        embed.addFields({
          name: `${name} (${durationLabel}) (${differenceLabel})`,
          value: fields.join(" | "),
          inline: false,
        });
      } else {
        embed.addFields({
          name: `${name} (${durationLabel})`,
          value: fields.join(" | "),
          inline: false,
        });
      }
    }

    return embed;
  }
}
