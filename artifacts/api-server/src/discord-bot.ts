import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionsBitField,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type Message,
  type ModalSubmitInteraction,
  type PermissionOverwriteOptions,
  type PermissionOverwrites,
  type Role,
  type RoleSelectMenuInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import cors from "cors";
import express from "express";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const logger = {
  info(details: unknown, message?: string) {
    console.log(message ?? details, message ? details : "");
  },
  warn(details: unknown, message?: string) {
    console.warn(message ?? details, message ? details : "");
  },
  error(details: unknown, message?: string) {
    console.error(message ?? details, message ? details : "");
  },
};

type ApplicationStatus = "pending" | "approved" | "rejected";

type RankRole = {
  rank: number;
  roleId: string;
};

type GuildConfig = {
  targetChannelId?: string;
  targetMessageId?: string;
  hcChannelId?: string;
  logChannelId?: string;
  hcRoleIds: string[];
  rankRoles: RankRole[];
};

type Application = {
  id: string;
  guildId: string;
  applicantId: string;
  firstName: string;
  lastName: string;
  memberId: string;
  rank: number;
  invitedBy: string;
  invitedById?: string;
  rejectionReason?: string;
  status: ApplicationStatus;
  approvalMessageId?: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  nicknameApplied?: boolean;
};

type BotState = {
  guilds: Record<string, GuildConfig>;
  applications: Record<string, Application>;
};

const dataDirectory =
  process.env["RAILWAY_VOLUME_MOUNT_PATH"] ?? path.resolve(process.cwd(), "data");
const statePath = path.join(dataDirectory, "verification-state.json");
const defaultState: BotState = { guilds: {}, applications: {} };

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const state = await loadState();
let stateWriteQueue = Promise.resolve();

const commandNames = {
  setup: "verification-setup",
  addRank: "rank-add",
  removeRank: "rank-remove",
  listRanks: "rank-list",
  addHcRole: "hc-role-add",
  removeHcRole: "hc-role-remove",
  listHcRoles: "hc-role-list",
  setupHcRoles: "hc-role-setup",
  status: "verification-status",
  copyRole: "copy-role",
} as const;

async function loadState(): Promise<BotState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BotState>;
    return {
      guilds: parsed.guilds ?? {},
      applications: parsed.applications ?? {},
    };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
    if (code !== "ENOENT") {
      logger.warn({ err: error }, "Could not read verification state; starting empty");
    }
    return structuredClone(defaultState);
  }
}

function saveState(): Promise<void> {
  stateWriteQueue = stateWriteQueue.then(async () => {
    await mkdir(path.dirname(statePath), { recursive: true });
    const temporaryStatePath = `${statePath}.tmp`;
    await writeFile(temporaryStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporaryStatePath, statePath);
  });
  return stateWriteQueue;
}

function getGuildConfig(guildId: string): GuildConfig {
  const existing = state.guilds[guildId];
  if (existing) {
    existing.rankRoles ??= [];
    existing.hcRoleIds ??= [];
    return existing;
  }
  const config: GuildConfig = {
    rankRoles: [],
    hcRoleIds: [],
  };
  state.guilds[guildId] = config;
  return config;
}

function isAdmin(
  interaction:
    | ChatInputCommandInteraction
    | ButtonInteraction
    | ModalSubmitInteraction
    | RoleSelectMenuInteraction,
): boolean {
  const permissions = interaction.memberPermissions;
  return Boolean(
    permissions?.has(PermissionsBitField.Flags.Administrator) ||
      permissions?.has(PermissionsBitField.Flags.ManageGuild),
  );
}

function canProcessApplications(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  config: GuildConfig | undefined,
): boolean {
  if (isAdmin(interaction)) return true;
  return hasConfiguredHcRole(interaction, config);
}

function hasConfiguredHcRole(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  config: GuildConfig | undefined,
): boolean {
  if (!config?.hcRoleIds.length) return false;
  const member = interaction.member;
  if (!member || !("roles" in member)) return false;
  return config.hcRoleIds.some((roleId) =>
    Array.isArray(member.roles) ? member.roles.includes(roleId) : member.roles.cache.has(roleId),
  );
}

function getMissingChannelPermissions(
  channel: unknown,
  botMember: GuildMember,
  required: Array<{ flag: bigint; label: string }>,
): string[] {
  if (
    !channel ||
    typeof channel !== "object" ||
    !("permissionsFor" in channel) ||
    typeof channel.permissionsFor !== "function"
  ) {
    return ["channel access"];
  }

  const permissions = channel.permissionsFor(botMember);
  if (!permissions) return ["channel access"];
  return required
    .filter(({ flag }) => !permissions.has(flag))
    .map(({ label }) => label);
}

function discordErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

const channelSendPermissions = [
  { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
  { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
  { flag: PermissionFlagsBits.EmbedLinks, label: "Embed Links" },
  { flag: PermissionFlagsBits.ReadMessageHistory, label: "Read Message History" },
];

function isApplicationStaff(interaction: ChatInputCommandInteraction): boolean {
  return isAdmin(interaction);
}

function canUseHcCommand(interaction: ChatInputCommandInteraction | ButtonInteraction): boolean {
  return isAdmin(interaction) || hasConfiguredHcRole(interaction, state.guilds[interaction.guildId ?? ""]);
}

function getRankRole(config: GuildConfig, rank: number): RankRole | undefined {
  return config.rankRoles.find((entry) => entry.rank === rank);
}

function applicationButtons(applicationId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_application:${applicationId}`)
      .setLabel("Approve")
      .setEmoji("🟢")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`reject_application:${applicationId}`)
      .setLabel("Reject")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function copyRoleButton(sourceRoleId: string, targetRoleId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_role:${sourceRoleId}:${targetRoleId}`)
      .setLabel("Copy all")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

function applicationStartButton(guildId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`start_application:${guildId}`)
      .setLabel("Apply")
      .setStyle(ButtonStyle.Primary),
  );
}

function applicationEmbed(
  application: Application,
  memberMention: string,
  roleMention: string,
): EmbedBuilder {
  const color = application.status === "approved"
    ? 0x3fb950
    : application.status === "rejected"
      ? 0xf85149
      : 0xf0b429;

  const status = application.status === "approved"
    ? "APPROVED"
    : application.status === "rejected"
      ? "REJECTED"
      : "PENDING";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(application.status === "pending" ? "📋 NEW APPLICATION" : `📋 APPLICATION — ${status}`)
    .setDescription(`Application: \`${application.id}\``)
    .addFields(
      { name: "First and last name", value: `${application.firstName} ${application.lastName}`, inline: true },
      { name: "ID", value: application.memberId, inline: true },
      { name: "Rank", value: `Rank ${application.rank}`, inline: true },
      { name: "Who added them", value: application.invitedBy, inline: true },
      { name: "User", value: memberMention, inline: true },
      { name: "Assigned role", value: roleMention, inline: true },
    )
    .setTimestamp(new Date(application.createdAt));

  if (application.rejectionReason) {
    embed.addFields({ name: "Rejection reason", value: application.rejectionReason });
  }
  if (application.decidedAt) {
    embed.addFields({ name: "Decision time", value: `<t:${Math.floor(new Date(application.decidedAt).getTime() / 1000)}:F>` });
  }
  return embed;
}

function buildApplicationModal(guildId: string, rank: number): ModalBuilder {
  const input = (
    customId: string,
    label: string,
    placeholder: string,
    style = TextInputStyle.Short,
  ) =>
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setPlaceholder(placeholder)
      .setStyle(style)
      .setRequired(true)
      .setMaxLength(100);

  return new ModalBuilder()
    .setCustomId(`submit_application:${guildId}:${rank}`)
    .setTitle("Server application")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("first_name", "First name", "Enter your first name"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("last_name", "Last name", "Enter your last name"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("member_id", "ID", "Enter your ID"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("invited_by", "Who added/invited you", "Enter the name of the person who added you"),
      ),
    );
}

function applicationPrompt(guildId: string, config: GuildConfig) {
  const rankOptions = config.rankRoles.map((entry) => ({
    label: `Rank ${entry.rank}`,
    value: String(entry.rank),
    description: "Choose the rank you are applying for",
  }));

  return {
    content:
      rankOptions.length > 0
        ? "Choose the rank you are applying for, then open the private application form."
        : "HC has not configured any ranks yet. Please try again later.",
    components: [
      ...(rankOptions.length > 0
        ? [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`choose_rank:${guildId}`)
                .setPlaceholder("Choose a rank")
                .addOptions(rankOptions),
            ),
          ]
        : []),
    ],
  };
}

function buildSelectedRankPrompt(guildId: string, rank: number) {
  return {
    content: `**Rank ${rank}** selected. Click the button to complete the private application form.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`open_application:${guildId}:${rank}`)
          .setLabel("Open application")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function buildRejectionModal(applicationId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`reject_reason:${applicationId}`)
    .setTitle("Reject application")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Rejection reason")
          .setPlaceholder("Optional")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );
}

function makeNickname(application: Application): string {
  const nickname = `${application.firstName} ${application.lastName} | ${application.memberId}`;
  return nickname.length <= 32 ? nickname : nickname.slice(0, 32);
}

function createCommands() {
  return [
    {
      name: commandNames.setup,
      description: "Publish the application panel and configure application channels",
      options: [
        {
          type: 7,
          name: "target_channel",
          description: "Channel where the application panel is published",
          required: true,
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
        {
          type: 7,
          name: "hc_channel",
          description: "Channel where applications are sent for approval",
          required: true,
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
        {
          type: 7,
          name: "log_channel",
          description: "Channel where approved and rejected applications are logged",
          required: true,
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
      ],
    },
    {
      name: commandNames.addRank,
      description: "Link a rank number to a Discord role",
      options: [
        {
          type: 4,
          name: "rank",
          description: "Rank number from 1 to 10",
          required: true,
          min_value: 1,
          max_value: 10,
        },
        {
          type: 8,
          name: "role",
          description: "Discord role for this rank",
          required: true,
        },
      ],
    },
    {
      name: commandNames.removeRank,
      description: "Remove the rank configuration",
      options: [
        {
          type: 4,
          name: "rank",
          description: "Rank number from 1 to 10",
          required: true,
          min_value: 1,
          max_value: 10,
        },
      ],
    },
    {
      name: commandNames.listRanks,
      description: "List configured ranks",
    },
    {
      name: commandNames.addHcRole,
      description: "Allow a role to approve and reject applications",
      options: [
        {
          type: 8,
          name: "role",
          description: "HC role",
          required: true,
        },
      ],
    },
    {
      name: commandNames.removeHcRole,
      description: "Remove a role from the HC permissions",
      options: [
        {
          type: 8,
          name: "role",
          description: "HC role",
          required: true,
        },
      ],
    },
    {
      name: commandNames.listHcRoles,
      description: "List roles that can process applications",
    },
    {
      name: commandNames.setupHcRoles,
      description: "Select all Admin/HC roles that process applications",
    },
    {
      name: commandNames.status,
      description: "Show the current verification configuration",
    },
    {
      name: commandNames.copyRole,
      description: "Copy all available settings from one role to another",
      options: [
        {
          type: 8,
          name: "source_role",
          description: "Role to copy settings from",
          required: true,
        },
        {
          type: 8,
          name: "target_role",
          description: "Role to copy settings to",
          required: true,
        },
      ],
    },
  ];
}

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only HC members and administrators can use this command.", ephemeral: true });
    return;
  }

  const targetChannel = interaction.options.getChannel("target_channel", true);
  const hcChannel = interaction.options.getChannel("hc_channel", true);
  const logChannel = interaction.options.getChannel("log_channel", true);

  if (
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChannel.type) ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(hcChannel.type) ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(logChannel.type)
  ) {
    await interaction.reply({ content: "Choose text channels.", ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "The server is not available.", ephemeral: true });
    return;
  }

  const botMember = await guild.members.fetchMe().catch(() => undefined);
  if (!botMember) {
    await interaction.reply({
      content: "I cannot check the bot's server permissions. Make sure the bot is a member of this server.",
      ephemeral: true,
    });
    return;
  }

  const channelChecks = [
    { channel: targetChannel, label: "panel channel" },
    { channel: hcChannel, label: "HC channel" },
    { channel: logChannel, label: "log channel" },
  ];
  for (const { channel, label } of channelChecks) {
    const missing = getMissingChannelPermissions(channel, botMember, channelSendPermissions);
    if (missing.length > 0) {
      await interaction.reply({
        content: `The bot cannot use the ${label} <#${channel.id}>. Missing permissions: ${missing.join(", ")}.`,
        ephemeral: true,
      });
      return;
    }
  }

  if (!("send" in targetChannel)) {
    await interaction.reply({ content: "The selected panel channel cannot send messages.", ephemeral: true });
    return;
  }

  let panelMessage: Message;
  try {
    panelMessage = await targetChannel.send({
      content: [
        "## 📋 Server application",
        "",
        "Click the **button below** to fill out the application privately.",
        "",
        "### How to complete the application",
        "",
        "1. Click the **Apply** button.",
        "2. Choose the **rank** you want.",
        "3. Enter your **first and last name**.",
        "4. Enter your **ID**.",
        "5. Enter the name of the **person who added you**.",
        "6. Check that all information is correct.",
        "7. Submit the application and wait for **HC/Admin approval**.",
        "",
        "⚠️ **IMPORTANT:** If you do not complete the application or provide all required information, **you will not receive a rank/role**.",
        "",
        "After submitting the application, you must wait for HC/Admin approval. **The rank is assigned only after the application is approved.**",
      ].join("\n"),
      components: [applicationStartButton(interaction.guildId!)],
    });
  } catch {
    await interaction.reply({
      content: "I could not publish the panel. Make sure the bot has View Channel and Send Messages permissions.",
      ephemeral: true,
    });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  config.targetChannelId = targetChannel.id;
  config.targetMessageId = panelMessage.id;
  config.hcChannelId = hcChannel.id;
  config.logChannelId = logChannel.id;
  await saveState();

  await interaction.reply({
    content:
      `Configured. The application panel was published in <#${targetChannel.id}> (\`${panelMessage.id}\`), applications go to <#${hcChannel.id}>, and logs go to <#${logChannel.id}>.`,
    ephemeral: true,
  });
}

async function handleAddRank(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only HC members and administrators can use this command.", ephemeral: true });
    return;
  }

  const rank = interaction.options.getInteger("rank", true);
  const role = interaction.options.getRole("role", true);
  const config = getGuildConfig(interaction.guildId!);
  const existing = getRankRole(config, rank);

  if (existing) {
    existing.roleId = role.id;
  } else {
    config.rankRoles.push({ rank, roleId: role.id });
  }
  config.rankRoles.sort((a, b) => a.rank - b.rank);
  await saveState();

  await interaction.reply({
    content: `Rank ${rank} is now linked to the ${role} role.`,
    ephemeral: true,
  });
}

async function handleRemoveRank(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only HC members and administrators can use this command.", ephemeral: true });
    return;
  }

  const rank = interaction.options.getInteger("rank", true);
  const config = getGuildConfig(interaction.guildId!);
  const before = config.rankRoles.length;
  config.rankRoles = config.rankRoles.filter((entry) => entry.rank !== rank);
  await saveState();

  await interaction.reply({
    content: before === config.rankRoles.length
      ? `Rank ${rank} was not configured.`
      : `The configuration for rank ${rank} was removed.`,
    ephemeral: true,
  });
}

async function handleListRanks(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only HC members and administrators can use this command.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  if (config.rankRoles.length === 0) {
    await interaction.reply({ content: "No ranks are configured. Use `/rank-add`.", ephemeral: true });
    return;
  }

  await interaction.reply({
    content: config.rankRoles
      .map((entry) => `Rank ${entry.rank} → <@&${entry.roleId}>`)
      .join("\n"),
    ephemeral: true,
  });
}

async function handleAddHcRole(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only administrators can use this command.", ephemeral: true });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const config = getGuildConfig(interaction.guildId!);
  if (!config.hcRoleIds.includes(role.id)) {
    config.hcRoleIds.push(role.id);
    await saveState();
  }

  await interaction.reply({
    content: `${role} can now approve and reject applications.`,
    ephemeral: true,
  });
}

async function handleRemoveHcRole(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only administrators can use this command.", ephemeral: true });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const config = getGuildConfig(interaction.guildId!);
  const before = config.hcRoleIds.length;
  config.hcRoleIds = config.hcRoleIds.filter((roleId) => roleId !== role.id);
  await saveState();

  await interaction.reply({
    content: before === config.hcRoleIds.length
      ? `${role} was not configured as an HC role.`
      : `${role} can no longer process applications.`,
    ephemeral: true,
  });
}

async function handleListHcRoles(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only administrators can use this command.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  await interaction.reply({
    content: config.hcRoleIds.length > 0
      ? config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join("\n")
      : "No specific HC roles are configured. Administrators with the Manage Server permission can still process applications.",
    ephemeral: true,
  });
}

async function handleSetupHcRoles(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only administrators can use this command.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  await interaction.reply({
    content: [
      "Select all roles that can approve and reject applications.",
      config.hcRoleIds.length > 0
        ? `Currently selected: ${config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(", ")}`
        : "No roles are currently selected.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`configure_hc_roles:${interaction.guildId}`)
          .setPlaceholder("Select Admin/HC roles")
          .setMinValues(0)
          .setMaxValues(25),
      ),
    ],
    ephemeral: true,
  });
}

async function handleHcRoleSelection(interaction: RoleSelectMenuInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: "Only administrators can use this command.", ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "The server is not available.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(guildId);
  config.hcRoleIds = [...new Set(interaction.values)];
  await saveState();

  await interaction.update({
    content: config.hcRoleIds.length > 0
      ? `✅ Configured Admin/HC roles: ${config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(", ")}\nThey will be notified and can approve or reject applications.`
      : "✅ All specifically configured Admin/HC roles were removed. Only server administrators can process applications.",
    components: [],
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Only HC members and administrators can use this command.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  const pending = Object.values(state.applications).filter(
    (application) => application.guildId === interaction.guildId && application.status === "pending",
  ).length;

  await interaction.reply({
    content: [
      `Application panel: ${config.targetMessageId ? `<#${config.targetChannelId}> / \`${config.targetMessageId}\`` : "not configured"}`,
      `HC channel: ${config.hcChannelId ? `<#${config.hcChannelId}>` : "not configured"}`,
      `Log channel: ${config.logChannelId ? `<#${config.logChannelId}>` : "not configured"}`,
      `Configured ranks: ${config.rankRoles.length}/10`,
      `HC roles: ${config.hcRoleIds.length > 0 ? config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "administrators only"}`,
      `Pending applications: ${pending}`,
    ].join("\n"),
    ephemeral: true,
  });
}

async function handleCopyRoleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canUseHcCommand(interaction)) {
    await interaction.reply({
      content: "Only administrators or configured HC roles can use this command.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }

  const sourceRoleOption = interaction.options.getRole("source_role", true);
  const targetRoleOption = interaction.options.getRole("target_role", true);
  const sourceRole = await guild.roles.fetch(sourceRoleOption.id);
  const targetRole = await guild.roles.fetch(targetRoleOption.id);
  if (!sourceRole || !targetRole) {
    await interaction.reply({ content: "The Source or Target Role no longer exists.", ephemeral: true });
    return;
  }

  if (sourceRole.id === targetRole.id) {
    await interaction.reply({
      content: "Source Role and Target Role must be different roles.",
      ephemeral: true,
    });
    return;
  }

  if (sourceRole.id === interaction.guildId || targetRole.id === interaction.guildId) {
    await interaction.reply({
      content: "The default @everyone role cannot be the source or target.",
      ephemeral: true,
    });
    return;
  }

  if (targetRole.managed || !targetRole.editable) {
    await interaction.reply({
      content: "The bot cannot modify the Target Role. Make sure it is not a managed role and that the bot role is above it.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: [
      `**Source Role:** ${sourceRole}`,
      `**Target Role:** ${targetRole}`,
      "",
      "Permissions, hoist, mentionable, icon/unicode emoji, and all channel/category permissions supported by the Discord API will be copied. The Target Role name and color will remain unchanged.",
      "Click the button only after checking both roles.",
    ].join("\n"),
    components: [copyRoleButton(sourceRole.id, targetRole.id)],
    ephemeral: true,
  });
}

function buildPermissionOverwriteOptions(overwrite: PermissionOverwrites): PermissionOverwriteOptions {
  const options: Record<string, boolean | null> = {};
  for (const permission of Object.keys(PermissionFlagsBits) as Array<keyof typeof PermissionFlagsBits>) {
    options[permission] = overwrite.allow.has(permission)
      ? true
      : overwrite.deny.has(permission)
        ? false
        : null;
  }
  return options as PermissionOverwriteOptions;
}

async function copyRoleSettings(
  sourceRole: Role,
  targetRole: Role,
): Promise<{ copiedOverwrites: number; removedOverwrites: number; failedOverwrites: number }> {
  const sourceIconUrl = sourceRole.iconURL({ extension: "png", size: 256 });
  await targetRole.edit({
    hoist: sourceRole.hoist,
    mentionable: sourceRole.mentionable,
    permissions: sourceRole.permissions,
    icon: sourceIconUrl,
    unicodeEmoji: sourceRole.unicodeEmoji,
    reason: `Copy role settings from ${sourceRole.id}`,
  });

  const channels = await sourceRole.guild.channels.fetch();
  let copiedOverwrites = 0;
  let removedOverwrites = 0;
  let failedOverwrites = 0;

  for (const channel of channels.values()) {
    if (!channel || !("permissionOverwrites" in channel)) continue;

    const sourceOverwrite = channel.permissionOverwrites.cache.get(sourceRole.id);
    const targetOverwrite = channel.permissionOverwrites.cache.get(targetRole.id);
    if (!sourceOverwrite && !targetOverwrite) continue;

    try {
      if (sourceOverwrite) {
        await channel.permissionOverwrites.edit(
          targetRole.id,
          buildPermissionOverwriteOptions(sourceOverwrite),
          { reason: `Copy channel permissions from ${sourceRole.id}` },
        );
        copiedOverwrites += 1;
      } else {
        await channel.permissionOverwrites.delete(
          targetRole.id,
          `Remove target overwrite because source role has none`,
        );
        removedOverwrites += 1;
      }
    } catch (error) {
      failedOverwrites += 1;
      logger.warn(
        { err: error, channelId: channel.id, sourceRoleId: sourceRole.id, targetRoleId: targetRole.id },
        "Could not copy role channel permissions",
      );
    }
  }

  return { copiedOverwrites, removedOverwrites, failedOverwrites };
}

async function handleCopyRoleButton(interaction: ButtonInteraction): Promise<void> {
  if (!canUseHcCommand(interaction)) {
    await interaction.reply({
      content: "Only administrators or configured HC roles can use this command.",
      ephemeral: true,
    });
    return;
  }

  const [, sourceRoleId, targetRoleId] = interaction.customId.split(":");
  const guild = interaction.guild;
  if (!guild || !sourceRoleId || !targetRoleId) {
    await interaction.reply({ content: "The server or roles are not available.", ephemeral: true });
    return;
  }

  const sourceRole = await guild.roles.fetch(sourceRoleId);
  const targetRole = await guild.roles.fetch(targetRoleId);
  if (!sourceRole || !targetRole) {
    await interaction.reply({ content: "The Source or Target Role no longer exists.", ephemeral: true });
    return;
  }
  if (sourceRole.id === targetRole.id) {
    await interaction.reply({ content: "Source Role and Target Role must be different roles.", ephemeral: true });
    return;
  }
  if (targetRole.managed || !targetRole.editable) {
    await interaction.reply({
      content: "The bot cannot modify the Target Role. Make sure it is not a managed role and that the bot role is above it.",
      ephemeral: true,
    });
    return;
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "The bot does not have the Manage Roles permission, so it cannot copy role settings.",
      ephemeral: true,
    });
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "The bot does not have the Manage Channels permission, so it cannot copy channel/category permissions.",
      ephemeral: true,
    });
    return;
  }

  await interaction.update({
    content: `Copying all settings from ${sourceRole} to ${targetRole}...`,
    components: [copyRoleButton(sourceRole.id, targetRole.id, true)],
  });

  try {
    const result = await copyRoleSettings(sourceRole, targetRole);
    const channelWarning = result.failedOverwrites > 0
      ? `\nWarning: ${result.failedOverwrites} channel/category permissions could not be copied.`
      : "";

    await interaction.editReply({
      content: [
        "✅ **Role copied successfully!**",
        "",
        `Source: ${sourceRole}`,
        `Target: ${targetRole}`,
        "Copied: all available settings except the Target Role name and color",
        `Channel/category permissions: ${result.copiedOverwrites} copied, ${result.removedOverwrites} removed.${channelWarning}`,
      ].join("\n"),
      components: [],
    });
  } catch (error) {
    logger.error(
      { err: error, sourceRoleId: sourceRole.id, targetRoleId: targetRole.id },
      "Could not copy role settings",
    );
    await interaction.editReply({
      content: [
        "❌ **Role copy failed.**",
        "",
        `Source: ${sourceRole}`,
        `Target: ${targetRole}`,
        "Make sure the bot has Manage Roles and Manage Channels permissions and that the bot role is above the Target Role.",
      ].join("\n"),
      components: [],
    });
  }
}

async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.commandName) {
    case commandNames.setup:
      await handleSetup(interaction);
      break;
    case commandNames.addRank:
      await handleAddRank(interaction);
      break;
    case commandNames.removeRank:
      await handleRemoveRank(interaction);
      break;
    case commandNames.listRanks:
      await handleListRanks(interaction);
      break;
    case commandNames.addHcRole:
      await handleAddHcRole(interaction);
      break;
    case commandNames.removeHcRole:
      await handleRemoveHcRole(interaction);
      break;
    case commandNames.listHcRoles:
      await handleListHcRoles(interaction);
      break;
    case commandNames.status:
      await handleStatus(interaction);
      break;
    case commandNames.copyRole:
      await handleCopyRoleCommand(interaction);
      break;
    default:
      break;
  }
}

async function handleApplicationSubmit(interaction: ModalSubmitInteraction) {
  const [, guildId, rankValue] = interaction.customId.split(":");
  const guild = client.guilds.cache.get(guildId);
  const config = guildId ? state.guilds[guildId] : undefined;
  if (!guild || !config?.hcChannelId) {
    await interaction.reply({ content: "Verification is not configured yet.", ephemeral: true });
    return;
  }

  const firstName = interaction.fields.getTextInputValue("first_name").trim();
  const lastName = interaction.fields.getTextInputValue("last_name").trim();
  const memberId = interaction.fields.getTextInputValue("member_id").trim();
  const invitedBy = interaction.fields.getTextInputValue("invited_by").trim();
  const rank = Number(rankValue);

  if (
    !firstName ||
    !lastName ||
    !memberId ||
    !invitedBy ||
    !Number.isInteger(rank) ||
    rank < 1 ||
    rank > 10
  ) {
    await interaction.reply({
      content: "Check your first name, last name, ID, and who added/invited you.",
      ephemeral: true,
    });
    return;
  }

  const rankRole = getRankRole(config, rank);
  if (!rankRole) {
    await interaction.reply({
      content: `Rank ${rank} is not configured on the server yet. Contact HC.`,
      ephemeral: true,
    });
    return;
  }

  const applicantMember = await guild.members.fetch(interaction.user.id).catch(() => undefined);
  if (!applicantMember) {
    await interaction.reply({
      content: "I cannot check your existing rank roles. Try again or contact an administrator.",
      ephemeral: true,
    });
    return;
  }

  const existingRankRoles = config.rankRoles.filter((entry) =>
    applicantMember.roles.cache.has(entry.roleId),
  );
  if (existingRankRoles.length > 0) {
    await interaction.reply({
      content: [
        "❌ You cannot submit an application because you already have a rank role.",
        `Existing ranks: ${existingRankRoles.map((entry) => `Rank ${entry.rank} (<@&${entry.roleId}>)`).join(", ")}`,
        "Applications are only allowed for members who do not have any configured rank.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  const duplicateMemberId = Object.values(state.applications).find(
    (application) =>
      application.guildId === guildId &&
      application.memberId.toLowerCase() === memberId.toLowerCase() &&
      application.status !== "rejected",
  );
  if (duplicateMemberId) {
    await interaction.reply({
      content: "This ID already exists in an active or approved application. Check the information with HC.",
      ephemeral: true,
    });
    return;
  }

  const hasPending = Object.values(state.applications).some(
    (application) =>
      application.guildId === guildId &&
      application.applicantId === interaction.user.id &&
      application.status === "pending",
  );
  if (hasPending) {
    await interaction.reply({ content: "You already have an application waiting for HC approval.", ephemeral: true });
    return;
  }

  const hcChannel = await guild.channels.fetch(config.hcChannelId).catch(() => undefined);
  if (
    !hcChannel ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(hcChannel.type) ||
    !hcChannel.isTextBased() ||
    !("send" in hcChannel)
  ) {
    await interaction.reply({
      content: `❌ The configured HC channel <#${config.hcChannelId}> is unavailable or is not a text channel. An administrator must run \`/verification-setup\` again.`,
      ephemeral: true,
    });
    return;
  }

  const botMember = await guild.members.fetchMe().catch(() => undefined);
  if (!botMember) {
    await interaction.reply({
      content: "❌ I cannot check the bot's server permissions. Contact an administrator.",
      ephemeral: true,
    });
    return;
  }

  const missingPermissions = getMissingChannelPermissions(hcChannel, botMember, channelSendPermissions);
  if (missingPermissions.length > 0) {
    await interaction.reply({
      content: [
        `❌ The bot cannot send the application to the HC channel <#${hcChannel.id}>.`,
        `Missing permissions: ${missingPermissions.join(", ")}.`,
        "An administrator should check the channel permissions and the bot role.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  const configuredRoles = await Promise.all(
    config.hcRoleIds.map(async (roleId) => guild.roles.fetch(roleId).catch(() => undefined)),
  );
  const missingRoleIds = config.hcRoleIds.filter((_, index) => !configuredRoles[index]);
  if (missingRoleIds.length > 0) {
    await interaction.reply({
      content: [
        "❌ One or more configured Admin/HC roles no longer exist on the server.",
        `Missing role IDs: ${missingRoleIds.join(", ")}`,
        "An administrator should configure the roles again with `/hc-role-setup`.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }

  const application: Application = {
    id: `app-${Date.now()}-${interaction.user.id.slice(-4)}`,
    guildId,
    applicantId: interaction.user.id,
    firstName,
    lastName,
    memberId,
    rank,
    invitedBy,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  const roleMention = `<@&${rankRole.roleId}>`;
  const hcRoleMentions = config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");
  let approvalMessage;
  try {
    approvalMessage = await hcChannel.send({
      content: hcRoleMentions || undefined,
      allowedMentions: {
        roles: config.hcRoleIds,
        users: [application.applicantId],
      },
      embeds: [applicationEmbed(application, `<@${application.applicantId}>`, roleMention)],
      components: [applicationButtons(application.id)],
    });
  } catch (error) {
    logger.error({ err: error, channelId: hcChannel.id, applicationId: application.id }, "Could not send HC application");
    await interaction.reply({
      content: [
        `❌ Sending the application to the HC channel <#${hcChannel.id}> failed.`,
        "Check the View Channel, Send Messages, Embed Links, and Read Message History permissions.",
        discordErrorCode(error) ? `Discord error code: ${discordErrorCode(error)}.` : "Discord did not accept the message.",
      ].join("\n"),
      ephemeral: true,
    });
    return;
  }
  state.applications[application.id] = application;
  application.approvalMessageId = approvalMessage.id;
  await saveState();

  await interaction.reply({
    content: "Your application was sent to HC for approval. Please wait for a response.",
    ephemeral: true,
  });
}

async function sendApplicationLog(
  guild: Guild,
  config: GuildConfig,
  application: Application,
  roleMention: string,
): Promise<void> {
  const channelId = config.logChannelId ?? config.hcChannelId;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => undefined);
  if (!channel?.isTextBased() || !("send" in channel)) return;

  await channel.send({
    embeds: [
      applicationEmbed(application, `<@${application.applicantId}>`, roleMention)
        .setTitle(`Application log — ${application.status === "approved" ? "APPROVED" : "REJECTED"}`),
    ],
  });
}

async function getApplicationFromButton(interaction: ButtonInteraction): Promise<Application | undefined> {
  const [, applicationId] = interaction.customId.split(":");
  return state.applications[applicationId];
}

async function handleApproval(
  interaction: ButtonInteraction,
  application: Application,
): Promise<void> {
  if (application.status !== "pending") {
    await interaction.reply({ content: "This application has already been resolved.", ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "The server is not available.", ephemeral: true });
    return;
  }
  const config = getGuildConfig(guild.id);
  if (!canProcessApplications(interaction, config)) {
    await interaction.reply({ content: "Only configured HC roles and administrators can approve applications.", ephemeral: true });
    return;
  }
  const rankRole = getRankRole(config, application.rank);
  if (!rankRole) {
    await interaction.reply({ content: `Rank ${application.rank} is no longer configured.`, ephemeral: true });
    return;
  }

  const role = await guild.roles.fetch(rankRole.roleId);
  const member = await guild.members.fetch(application.applicantId).catch(() => undefined);
  if (!role || !member) {
    await interaction.reply({
      content: "I cannot find the role or member. Check that the bot role is above the rank role.",
      ephemeral: true,
    });
    return;
  }
  if (!role.editable) {
    await interaction.reply({
      content: "The bot cannot assign this role. Move the bot role above the rank role in the Discord settings.",
      ephemeral: true,
    });
    return;
  }

  const botMember = await guild.members.fetchMe().catch(() => undefined);
  if (!botMember) {
    await interaction.reply({
      content: "I cannot check the bot permissions. Approval was not completed.",
      ephemeral: true,
    });
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "❌ Approval was not completed: the bot does not have the Manage Roles permission.",
      ephemeral: true,
    });
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames) || !member.manageable) {
    await interaction.reply({
      content: "❌ Approval was not completed: the bot does not have the Manage Nicknames permission or cannot change this member's nickname.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();
  const previousNickname = member.nickname;
  try {
    await member.setNickname(makeNickname(application));
    await member.roles.add(role);
  } catch (error) {
    if (member.nickname !== previousNickname) {
      await member.setNickname(previousNickname).catch(() => undefined);
    }
    logger.error({ err: error, applicationId: application.id }, "Could not complete application approval");
    await interaction.followUp({
      content: [
        "❌ Approval was not completed. The rank and nickname were not applied successfully.",
        "Check that the bot has Manage Roles and Manage Nicknames permissions and that its role is above the rank role.",
        discordErrorCode(error) ? `Discord error code: ${discordErrorCode(error)}.` : "",
      ].filter(Boolean).join("\n"),
      ephemeral: true,
    });
    return;
  }

  application.status = "approved";
  application.decidedAt = new Date().toISOString();
  application.decidedBy = interaction.user.id;
  application.nicknameApplied = true;
  await saveState();

  await interaction.message.edit({
    embeds: [
      applicationEmbed(
        application,
        `<@${application.applicantId}>`,
        `<@&${rankRole.roleId}>`,
      ).addFields({
        name: "Approved by",
        value: `<@${interaction.user.id}>`,
        inline: true,
      }),
    ],
    components: [applicationButtons(application.id, true)],
  });
  await sendApplicationLog(guild, config, application, `<@&${rankRole.roleId}>`);

  await interaction.followUp({
    content: "✅ The application was approved. The rank was assigned and the nickname was changed.",
    ephemeral: true,
  });
}

async function handleRejection(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  application: Application,
  reason = "",
): Promise<void> {
  if (application.status !== "pending") {
    await interaction.reply({ content: "This application has already been resolved.", ephemeral: true });
    return;
  }
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "The server is not available.", ephemeral: true });
    return;
  }
  const config = getGuildConfig(guild.id);
  if (!canProcessApplications(interaction, config)) {
    await interaction.reply({ content: "Only configured HC roles and administrators can reject applications.", ephemeral: true });
    return;
  }

  application.status = "rejected";
  application.decidedAt = new Date().toISOString();
  application.decidedBy = interaction.user.id;
  application.rejectionReason = reason || undefined;
  await saveState();

  const rankRole = getRankRole(config, application.rank);
  const rejectedEmbed = applicationEmbed(
    application,
    `<@${application.applicantId}>`,
    rankRole ? `<@&${rankRole.roleId}>` : "Not configured",
  ).addFields({
    name: "Rejected by",
    value: `<@${interaction.user.id}>`,
    inline: true,
  });

  if (interaction.isButton()) {
    await interaction.update({
      embeds: [rejectedEmbed],
      components: [applicationButtons(application.id, true)],
    });
    await interaction.followUp({
      content: "✅ The application was rejected and recorded.",
      ephemeral: true,
    });
  } else {
    await interaction.reply({ content: "The application was rejected and recorded.", ephemeral: true });
    await interaction.message?.edit({
      embeds: [rejectedEmbed],
      components: [applicationButtons(application.id, true)],
    }).catch(() => undefined);
  }
  await sendApplicationLog(guild, config, application, rankRole ? `<@&${rankRole.roleId}>` : "Not configured");

}

async function handleRankSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, guildId] = interaction.customId.split(":");
  const rank = Number(interaction.values[0]);
  const config = state.guilds[guildId];
  if (!config || !getRankRole(config, rank)) {
    await interaction.reply({ content: "This rank is no longer available.", ephemeral: true });
    return;
  }
  await interaction.update(buildSelectedRankPrompt(guildId, rank));
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId.startsWith("start_application:")) {
    const [, guildId] = interaction.customId.split(":");
    const config = state.guilds[guildId];
    if (!config || interaction.guildId !== guildId) {
      await interaction.reply({ content: "This panel is no longer active.", ephemeral: true });
      return;
    }

    await interaction.reply({
      ...applicationPrompt(guildId, config),
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId.startsWith("copy_role:")) {
    await handleCopyRoleButton(interaction);
    return;
  }

  if (interaction.customId.startsWith("open_application:")) {
    const [, guildId, rankValue] = interaction.customId.split(":");
    const rank = Number(rankValue);
    const config = state.guilds[guildId];
    if (!config || !getRankRole(config, rank)) {
      await interaction.reply({ content: "This rank is no longer available.", ephemeral: true });
      return;
    }
    await interaction.showModal(buildApplicationModal(guildId, rank));
    return;
  }

  if (interaction.customId.startsWith("approve_application:")) {
    const application = await getApplicationFromButton(interaction);
    if (application) {
      await handleApproval(interaction, application);
    } else {
      await interaction.reply({ content: "The application does not exist or was deleted.", ephemeral: true });
    }
    return;
  }

  if (interaction.customId.startsWith("reject_application:")) {
    const application = await getApplicationFromButton(interaction);
    if (application) {
      const config = interaction.guildId ? state.guilds[interaction.guildId] : undefined;
      if (!canProcessApplications(interaction, config)) {
        await interaction.reply({ content: "Only configured HC roles and administrators can reject applications.", ephemeral: true });
        return;
      }
      await interaction.showModal(buildRejectionModal(application.id));
    } else {
      await interaction.reply({ content: "The application does not exist or was deleted.", ephemeral: true });
    }
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  for (const guild of readyClient.guilds.cache.values()) {
    await guild.commands.set(createCommands());
  }
  logger.info({ user: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, "Discord bot ready");
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId.startsWith("choose_rank:")) {
        await handleRankSelect(interaction);
      }
    } else if (interaction.isRoleSelectMenu()) {
      if (interaction.customId.startsWith("configure_hc_roles:")) {
        await handleHcRoleSelection(interaction);
      }
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("submit_application:")) {
        await handleApplicationSubmit(interaction);
      } else if (interaction.customId.startsWith("reject_reason:")) {
        const [, applicationId] = interaction.customId.split(":");
        const application = state.applications[applicationId];
        if (!application) {
          await interaction.reply({ content: "The application does not exist or was deleted.", ephemeral: true });
        } else {
          const reason = interaction.fields.getTextInputValue("reason").trim();
          await handleRejection(interaction, application, reason);
        }
      }
    }
  } catch (error) {
    logger.error({ err: error, interactionId: interaction.id }, "Discord interaction failed");
    if (interaction.isRepliable()) {
      if (interaction.deferred) {
        await interaction.followUp({ content: "An error occurred. Try again or contact an administrator.", ephemeral: true })
          .catch(() => undefined);
      } else if (!interaction.replied) {
        await interaction.reply({ content: "An error occurred. Try again or contact an administrator.", ephemeral: true })
          .catch(() => undefined);
      }
    }
  }
});

export async function startDiscordBot(): Promise<void> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required to start the Discord bot.");
  }

  await client.login(token);
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get("/api/healthz", (_request, response) => {
  response.json({ status: "ok" });
});

const rawPort = process.env["PORT"] ?? "8080";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, () => {
  logger.info({ port }, "HTTP server listening");
});

await startDiscordBot();