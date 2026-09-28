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
      .setLabel("Potvrdi")
      .setEmoji("🟢")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`reject_application:${applicationId}`)
      .setLabel("Odbij")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function copyRoleButton(sourceRoleId: string, targetRoleId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`copy_role:${sourceRoleId}:${targetRoleId}`)
      .setLabel("Kopiraj sve")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
  );
}

function applicationStartButton(guildId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`start_application:${guildId}`)
      .setLabel("Prijavi se")
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
    ? "ODOBRENO"
    : application.status === "rejected"
      ? "ODBIJENO"
      : "ČEKA POTVRDU";

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Nova prijava — ${status}`)
    .setDescription(`Prijava: \`${application.id}\``)
    .addFields(
      { name: "Ime", value: application.firstName, inline: true },
      { name: "Prezime", value: application.lastName, inline: true },
      { name: "ID", value: application.memberId, inline: true },
      { name: "Rank", value: `Rank ${application.rank}`, inline: true },
      { name: "Ko ga je ubacio", value: application.invitedBy, inline: true },
      { name: "Discord korisnik", value: memberMention, inline: true },
      { name: "Dodeljena uloga", value: roleMention, inline: true },
    )
    .setTimestamp(new Date(application.createdAt));

  if (application.rejectionReason) {
    embed.addFields({ name: "Razlog odbijanja", value: application.rejectionReason });
  }
  if (application.decidedAt) {
    embed.addFields({ name: "Vreme odluke", value: `<t:${Math.floor(new Date(application.decidedAt).getTime() / 1000)}:F>` });
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
    .setTitle("Prijava za server")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("first_name", "Ime", "Unesi ime"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("last_name", "Prezime", "Unesi prezime"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("member_id", "ID", "Unesi svoj ID"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        input("invited_by", "Ko te je ubacio", "@korisnik ili Discord ID"),
      ),
    );
}

function applicationPrompt(guildId: string, config: GuildConfig) {
  const rankOptions = config.rankRoles.map((entry) => ({
    label: `Rank ${entry.rank}`,
    value: String(entry.rank),
    description: "Izaberi rank za koji se prijavljuješ",
  }));

  return {
    content:
      rankOptions.length > 0
        ? "Klikni na rank za koji se prijavljuješ, pa otvori privatnu formu."
        : "HC još nije podesio rankove. Pokušaj ponovo kasnije.",
    components: [
      ...(rankOptions.length > 0
        ? [
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId(`choose_rank:${guildId}`)
                .setPlaceholder("Izaberi rank")
                .addOptions(rankOptions),
            ),
          ]
        : []),
    ],
  };
}

function buildSelectedRankPrompt(guildId: string, rank: number) {
  return {
    content: `Izabran je **Rank ${rank}**. Klikni dugme da popuniš privatnu formu.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`open_application:${guildId}:${rank}`)
          .setLabel("Otvori prijavu")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function buildRejectionModal(applicationId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`reject_reason:${applicationId}`)
    .setTitle("Odbijanje prijave")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Razlog odbijanja")
          .setPlaceholder("Opcionalno")
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
      description: "Objavi panel sa dugmetom i podesi kanale za prijave",
      options: [
        {
          type: 7,
          name: "target_channel",
          description: "Kanal u koji se objavljuje panel za prijavu",
          required: true,
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
        {
          type: 7,
          name: "hc_channel",
          description: "Kanal u koji stižu prijave za potvrdu",
          required: true,
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
        {
          type: 7,
          name: "log_channel",
          description: "Kanal u koji se zapisuju odobrene i odbijene prijave",
          required: true,
          channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
        },
      ],
    },
    {
      name: commandNames.addRank,
      description: "Poveži broj ranka sa Discord rolom",
      options: [
        {
          type: 4,
          name: "rank",
          description: "Broj ranka od 1 do 10",
          required: true,
          min_value: 1,
          max_value: 10,
        },
        {
          type: 8,
          name: "role",
          description: "Discord rola za ovaj rank",
          required: true,
        },
      ],
    },
    {
      name: commandNames.removeRank,
      description: "Obriši podešavanje za rank",
      options: [
        {
          type: 4,
          name: "rank",
          description: "Broj ranka od 1 do 10",
          required: true,
          min_value: 1,
          max_value: 10,
        },
      ],
    },
    {
      name: commandNames.listRanks,
      description: "Prikaži podešene rankove",
    },
    {
      name: commandNames.addHcRole,
      description: "Dozvoli roli da potvrđuje i odbija prijave",
      options: [
        {
          type: 8,
          name: "role",
          description: "HC rola",
          required: true,
        },
      ],
    },
    {
      name: commandNames.removeHcRole,
      description: "Ukloni rolu iz HC dozvola",
      options: [
        {
          type: 8,
          name: "role",
          description: "HC rola",
          required: true,
        },
      ],
    },
    {
      name: commandNames.listHcRoles,
      description: "Prikaži role koje mogu obrađivati prijave",
    },
    {
      name: commandNames.setupHcRoles,
      description: "Odaberi sve Admin/HC roleove koji obrađuju prijave",
    },
    {
      name: commandNames.status,
      description: "Prikaži trenutno podešavanje verifikacije",
    },
    {
      name: commandNames.copyRole,
      description: "Kopiraj sve dostupne postavke sa jedne role na drugu",
      options: [
        {
          type: 8,
          name: "source_role",
          description: "Rola sa koje se kopiraju postavke",
          required: true,
        },
        {
          type: 8,
          name: "target_role",
          description: "Rola na koju se kopiraju postavke",
          required: true,
        },
      ],
    },
  ];
}

async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo HC/admini.", ephemeral: true });
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
    await interaction.reply({ content: "Izaberi tekstualne kanale.", ephemeral: true });
    return;
  }

  if (!("send" in targetChannel)) {
    await interaction.reply({ content: "Izabrani kanal ne može slati poruke.", ephemeral: true });
    return;
  }

  let panelMessage: Message;
  try {
    panelMessage = await targetChannel.send({
      content: [
        "## 📋 Prijava za server",
        "",
        "Klikni **dugme ispod** kako bi privatno ispunio prijavu.",
        "",
        "### Kako ispuniti prijavu?",
        "",
        "1. Klikni dugme **Prijavi se**.",
        "2. Odaberi **rank** koji želiš.",
        "3. Upiši svoje **ime i prezime**.",
        "4. Upiši svoj **ID**.",
        "5. Odaberi **osobu koja te je ubacila**.",
        "6. Provjeri jesu li svi podaci točni.",
        "7. Pošalji prijavu i pričekaj da je **HC/Admin potvrdi**.",
        "",
        "⚠️ **VAŽNO:** Ako ne ispuniš prijavu ili ne uneseš sve potrebne podatke, **nećeš dobiti rank/role**.",
        "",
        "Nakon slanja prijave moraš pričekati potvrdu HC/Admina. **Rank se dodjeljuje tek nakon što prijava bude potvrđena.**",
      ].join("\n"),
      components: [applicationStartButton(interaction.guildId!)],
    });
  } catch {
    await interaction.reply({
      content: "Ne mogu da objavim panel. Proveri da bot ima View Channel i Send Messages dozvole.",
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
      `Podešeno. Panel za prijavu je objavljen u <#${targetChannel.id}> (\`${panelMessage.id}\`), prijave idu u <#${hcChannel.id}>, a log u <#${logChannel.id}>.`,
    ephemeral: true,
  });
}

async function handleAddRank(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo HC/admini.", ephemeral: true });
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
    content: `Rank ${rank} je sada povezan sa rolom ${role}.`,
    ephemeral: true,
  });
}

async function handleRemoveRank(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo HC/admini.", ephemeral: true });
    return;
  }

  const rank = interaction.options.getInteger("rank", true);
  const config = getGuildConfig(interaction.guildId!);
  const before = config.rankRoles.length;
  config.rankRoles = config.rankRoles.filter((entry) => entry.rank !== rank);
  await saveState();

  await interaction.reply({
    content: before === config.rankRoles.length
      ? `Rank ${rank} nije bio podešen.`
      : `Podešavanje za rank ${rank} je obrisano.`,
    ephemeral: true,
  });
}

async function handleListRanks(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo HC/admini.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  if (config.rankRoles.length === 0) {
    await interaction.reply({ content: "Nema podešenih rankova. Koristi `/rank-add`.", ephemeral: true });
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
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo administratori.", ephemeral: true });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const config = getGuildConfig(interaction.guildId!);
  if (!config.hcRoleIds.includes(role.id)) {
    config.hcRoleIds.push(role.id);
    await saveState();
  }

  await interaction.reply({
    content: `${role} sada može da potvrđuje i odbija prijave.`,
    ephemeral: true,
  });
}

async function handleRemoveHcRole(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo administratori.", ephemeral: true });
    return;
  }

  const role = interaction.options.getRole("role", true);
  const config = getGuildConfig(interaction.guildId!);
  const before = config.hcRoleIds.length;
  config.hcRoleIds = config.hcRoleIds.filter((roleId) => roleId !== role.id);
  await saveState();

  await interaction.reply({
    content: before === config.hcRoleIds.length
      ? `${role} nije bila podešena kao HC rola.`
      : `${role} više ne može da obrađuje prijave.`,
    ephemeral: true,
  });
}

async function handleListHcRoles(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo administratori.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  await interaction.reply({
    content: config.hcRoleIds.length > 0
      ? config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join("\n")
      : "Nema posebno podešenih HC rola. Administratori sa Manage Server dozvolom i dalje mogu obrađivati prijave.",
    ephemeral: true,
  });
}

async function handleSetupHcRoles(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo administratori.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  await interaction.reply({
    content: [
      "Odaberi sve roleove koji mogu potvrđivati i odbijati prijave.",
      config.hcRoleIds.length > 0
        ? `Trenutno odabrani: ${config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(", ")}`
        : "Trenutno nema odabranih roleova.",
    ].join("\n"),
    components: [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`configure_hc_roles:${interaction.guildId}`)
          .setPlaceholder("Odaberi Admin/HC roleove")
          .setMinValues(0)
          .setMaxValues(25),
      ),
    ],
    ephemeral: true,
  });
}

async function handleHcRoleSelection(interaction: RoleSelectMenuInteraction): Promise<void> {
  if (!isAdmin(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo administratori.", ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Server nije dostupan.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(guildId);
  config.hcRoleIds = [...new Set(interaction.values)];
  await saveState();

  await interaction.update({
    content: config.hcRoleIds.length > 0
      ? `✅ Podešeni Admin/HC roleovi: ${config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(", ")}\nOni će dobijati obaveštenja i moći će da potvrđuju ili odbijaju prijave.`
      : "✅ Uklonjeni su svi posebno podešeni Admin/HC roleovi. Samo server administratori mogu obrađivati prijave.",
    components: [],
  });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isApplicationStaff(interaction)) {
    await interaction.reply({ content: "Ovu komandu mogu koristiti samo HC/admini.", ephemeral: true });
    return;
  }

  const config = getGuildConfig(interaction.guildId!);
  const pending = Object.values(state.applications).filter(
    (application) => application.guildId === interaction.guildId && application.status === "pending",
  ).length;

  await interaction.reply({
    content: [
      `Panel za prijavu: ${config.targetMessageId ? `<#${config.targetChannelId}> / \`${config.targetMessageId}\`` : "nije podešen"}`,
      `HC kanal: ${config.hcChannelId ? `<#${config.hcChannelId}>` : "nije podešen"}`,
      `Log kanal: ${config.logChannelId ? `<#${config.logChannelId}>` : "nije podešen"}`,
      `Podešenih rankova: ${config.rankRoles.length}/10`,
      `HC rola: ${config.hcRoleIds.length > 0 ? config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(", ") : "samo administratori"}`,
      `Prijava na čekanju: ${pending}`,
    ].join("\n"),
    ephemeral: true,
  });
}

async function handleCopyRoleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canUseHcCommand(interaction)) {
    await interaction.reply({
      content: "Ovu komandu mogu koristiti samo administratori ili podešene HC role.",
      ephemeral: true,
    });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Ova komanda se može koristiti samo na serveru.", ephemeral: true });
    return;
  }

  const sourceRoleOption = interaction.options.getRole("source_role", true);
  const targetRoleOption = interaction.options.getRole("target_role", true);
  const sourceRole = await guild.roles.fetch(sourceRoleOption.id);
  const targetRole = await guild.roles.fetch(targetRoleOption.id);
  if (!sourceRole || !targetRole) {
    await interaction.reply({ content: "Source ili Target Role više ne postoji.", ephemeral: true });
    return;
  }

  if (sourceRole.id === targetRole.id) {
    await interaction.reply({
      content: "Source Role i Target Role moraju biti različite role.",
      ephemeral: true,
    });
    return;
  }

  if (sourceRole.id === interaction.guildId || targetRole.id === interaction.guildId) {
    await interaction.reply({
      content: "Defaultna @everyone rola ne može biti source ili target.",
      ephemeral: true,
    });
    return;
  }

  if (targetRole.managed || !targetRole.editable) {
    await interaction.reply({
      content: "Bot ne može menjati Target Role. Proveri da target nije managed rola i da je botova rola iznad nje.",
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: [
      `**Source Role:** ${sourceRole}`,
      `**Target Role:** ${targetRole}`,
      "",
      "Kopiraće se naziv, permissions, boja, hoist, mentionable, icon/unicode emoji i sve channel/category dozvole koje Discord API dopušta.",
      "Klikni dugme tek kada proveriš oba rolea.",
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
    name: sourceRole.name,
    colors: {
      primaryColor: sourceRole.colors.primaryColor,
      secondaryColor: sourceRole.colors.secondaryColor,
      tertiaryColor: sourceRole.colors.tertiaryColor,
    },
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
      content: "Ovu komandu mogu koristiti samo administratori ili podešene HC role.",
      ephemeral: true,
    });
    return;
  }

  const [, sourceRoleId, targetRoleId] = interaction.customId.split(":");
  const guild = interaction.guild;
  if (!guild || !sourceRoleId || !targetRoleId) {
    await interaction.reply({ content: "Server ili role nisu dostupni.", ephemeral: true });
    return;
  }

  const sourceRole = await guild.roles.fetch(sourceRoleId);
  const targetRole = await guild.roles.fetch(targetRoleId);
  if (!sourceRole || !targetRole) {
    await interaction.reply({ content: "Source ili Target Role više ne postoji.", ephemeral: true });
    return;
  }
  if (sourceRole.id === targetRole.id) {
    await interaction.reply({ content: "Source Role i Target Role moraju biti različite role.", ephemeral: true });
    return;
  }
  if (targetRole.managed || !targetRole.editable) {
    await interaction.reply({
      content: "Bot ne može menjati Target Role. Proveri da target nije managed rola i da je botova rola iznad nje.",
      ephemeral: true,
    });
    return;
  }

  const botMember = await guild.members.fetchMe();
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "Bot nema Manage Roles dozvolu, pa ne može kopirati postavke role.",
      ephemeral: true,
    });
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "Bot nema Manage Channels dozvolu, pa ne može kopirati channel/category permissions.",
      ephemeral: true,
    });
    return;
  }

  await interaction.update({
    content: `Kopiram sve postavke sa ${sourceRole} na ${targetRole}...`,
    components: [copyRoleButton(sourceRole.id, targetRole.id, true)],
  });

  try {
    const result = await copyRoleSettings(sourceRole, targetRole);
    const channelWarning = result.failedOverwrites > 0
      ? `\nUpozorenje: ${result.failedOverwrites} channel/category dozvola nije mogla biti kopirana.`
      : "";

    await interaction.editReply({
      content: [
        "✅ **Role uspješno kopiran!**",
        "",
        `Source: ${sourceRole}`,
        `Target: ${targetRole}`,
        "Kopirano: sve dostupne postavke",
        `Channel/category dozvole: ${result.copiedOverwrites} kopirano, ${result.removedOverwrites} uklonjeno.${channelWarning}`,
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
        "❌ **Kopiranje role nije uspelo.**",
        "",
        `Source: ${sourceRole}`,
        `Target: ${targetRole}`,
        "Proveri da bot ima Manage Roles i Manage Channels, te da je botova rola iznad Target Role.",
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

function extractDiscordUserId(value: string): string | undefined {
  const mention = value.match(/^<@!?(\d+)>$/);
  if (mention) return mention[1];
  return /^\d+$/.test(value) ? value : undefined;
}

async function handleApplicationSubmit(interaction: ModalSubmitInteraction) {
  const [, guildId, rankValue] = interaction.customId.split(":");
  const guild = client.guilds.cache.get(guildId);
  const config = guildId ? state.guilds[guildId] : undefined;
  if (!guild || !config?.hcChannelId) {
    await interaction.reply({ content: "Verifikacija trenutno nije podešena.", ephemeral: true });
    return;
  }

  const firstName = interaction.fields.getTextInputValue("first_name").trim();
  const lastName = interaction.fields.getTextInputValue("last_name").trim();
  const memberId = interaction.fields.getTextInputValue("member_id").trim();
  const invitedByValue = interaction.fields.getTextInputValue("invited_by").trim();
  const invitedById = extractDiscordUserId(invitedByValue);
  const rank = Number(rankValue);

  if (
    !firstName ||
    !lastName ||
    !memberId ||
    !invitedById ||
    !Number.isInteger(rank) ||
    rank < 1 ||
    rank > 10
  ) {
    await interaction.reply({
      content: "Proveri podatke. Rank je izabran iz menija, a osobu koja te je ubacila unesi kao Discord mention ili ID.",
      ephemeral: true,
    });
    return;
  }

  const rankRole = getRankRole(config, rank);
  if (!rankRole) {
    await interaction.reply({
      content: `Rank ${rank} još nije podešen na serveru. Javi se HC-u.`,
      ephemeral: true,
    });
    return;
  }

  const invitedByMember = await guild.members.fetch(invitedById).catch(() => undefined);
  if (!invitedByMember) {
    await interaction.reply({
      content: "Ne mogu da pronađem osobu koja te je ubacila na ovom serveru. Koristi njen Discord mention ili tačan ID.",
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
      content: "Ovaj ID već postoji u aktivnoj ili potvrđenoj prijavi. Proveri podatke sa HC-om.",
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
    await interaction.reply({ content: "Već imaš prijavu koja čeka potvrdu HC-a.", ephemeral: true });
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
    invitedBy: `<@${invitedByMember.id}>`,
    invitedById: invitedByMember.id,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  state.applications[application.id] = application;

  const hcChannel = await guild.channels.fetch(config.hcChannelId).catch(() => undefined);
  if (!hcChannel?.isTextBased() || !("send" in hcChannel)) {
    delete state.applications[application.id];
    await interaction.reply({ content: "HC kanal nije dostupan. Javi se administratoru.", ephemeral: true });
    return;
  }

  const roleMention = `<@&${rankRole.roleId}>`;
  const hcRoleMentions = config.hcRoleIds.map((roleId) => `<@&${roleId}>`).join(" ");
  let approvalMessage;
  try {
    approvalMessage = await hcChannel.send({
      content: hcRoleMentions || undefined,
      allowedMentions: config.hcRoleIds.length > 0 ? { roles: config.hcRoleIds } : undefined,
      embeds: [applicationEmbed(application, `<@${interaction.user.id}>`, roleMention)],
      components: [applicationButtons(application.id)],
    });
  } catch {
    delete state.applications[application.id];
    await saveState();
    await interaction.reply({
      content: "Ne mogu da pošaljem prijavu u HC kanal. Proveri dozvole bota i pokušaj ponovo.",
      ephemeral: true,
    });
    return;
  }
  application.approvalMessageId = approvalMessage.id;
  await saveState();

  await interaction.reply({
    content: "Prijava je poslata HC-u na potvrdu. Sačekaj odgovor.",
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
        .setTitle(`Log prijave — ${application.status === "approved" ? "POTVRĐENO" : "ODBIJENO"}`),
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
    await interaction.reply({ content: "Ova prijava je već rešena.", ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Server nije dostupan.", ephemeral: true });
    return;
  }
  const config = getGuildConfig(guild.id);
  if (!canProcessApplications(interaction, config)) {
    await interaction.reply({ content: "Samo podešene HC role i administratori mogu potvrditi prijavu.", ephemeral: true });
    return;
  }
  const rankRole = getRankRole(config, application.rank);
  if (!rankRole) {
    await interaction.reply({ content: `Rank ${application.rank} više nije podešen.`, ephemeral: true });
    return;
  }

  const role = await guild.roles.fetch(rankRole.roleId);
  const member = await guild.members.fetch(application.applicantId).catch(() => undefined);
  if (!role || !member) {
    await interaction.reply({
      content: "Ne mogu da pronađem rolu ili člana. Proveri da li je bot iznad rank role.",
      ephemeral: true,
    });
    return;
  }
  if (!role.editable) {
    await interaction.reply({
      content: "Bot ne može da dodeli ovu rolu. Premesti bot rolu iznad rank role u Discord podešavanjima.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();
  await member.roles.add(role);
  let nicknameApplied = true;
  try {
    await member.setNickname(makeNickname(application));
  } catch (error) {
    nicknameApplied = false;
    logger.warn({ err: error, applicationId: application.id }, "Could not set member nickname");
  }

  application.status = "approved";
  application.decidedAt = new Date().toISOString();
  application.decidedBy = interaction.user.id;
  application.nicknameApplied = nicknameApplied;
  await saveState();

  await interaction.message.edit({
    embeds: [
      applicationEmbed(
        application,
        `<@${application.applicantId}>`,
        `<@&${rankRole.roleId}>`,
      ).addFields({
        name: "Potvrdio",
        value: `<@${interaction.user.id}>`,
        inline: true,
      }),
    ],
    components: [applicationButtons(application.id, true)],
  });
  await sendApplicationLog(guild, config, application, `<@&${rankRole.roleId}>`);

  await interaction.followUp({
    content: nicknameApplied
      ? "✅ Prijava je potvrđena. Rank je dodeljen i nickname je promenjen."
      : "✅ Prijava je potvrđena i rank je dodeljen, ali nickname nije promenjen zbog Discord dozvola.",
    ephemeral: true,
  });
}

async function handleRejection(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  application: Application,
  reason = "",
): Promise<void> {
  if (application.status !== "pending") {
    await interaction.reply({ content: "Ova prijava je već rešena.", ephemeral: true });
    return;
  }
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Server nije dostupan.", ephemeral: true });
    return;
  }
  const config = getGuildConfig(guild.id);
  if (!canProcessApplications(interaction, config)) {
    await interaction.reply({ content: "Samo podešene HC role i administratori mogu odbiti prijavu.", ephemeral: true });
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
    rankRole ? `<@&${rankRole.roleId}>` : "Nije podešeno",
  ).addFields({
    name: "Odbio",
    value: `<@${interaction.user.id}>`,
    inline: true,
  });

  if (interaction.isButton()) {
    await interaction.update({
      embeds: [rejectedEmbed],
      components: [applicationButtons(application.id, true)],
    });
    await interaction.followUp({
      content: "✅ Prijava je odbijena i evidentirana.",
      ephemeral: true,
    });
  } else {
    await interaction.reply({ content: "Prijava je odbijena i evidentirana.", ephemeral: true });
    await interaction.message?.edit({
      embeds: [rejectedEmbed],
      components: [applicationButtons(application.id, true)],
    }).catch(() => undefined);
  }
  await sendApplicationLog(guild, config, application, rankRole ? `<@&${rankRole.roleId}>` : "Nije podešeno");

}

async function handleRankSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [, guildId] = interaction.customId.split(":");
  const rank = Number(interaction.values[0]);
  const config = state.guilds[guildId];
  if (!config || !getRankRole(config, rank)) {
    await interaction.reply({ content: "Ovaj rank više nije dostupan.", ephemeral: true });
    return;
  }
  await interaction.update(buildSelectedRankPrompt(guildId, rank));
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId.startsWith("start_application:")) {
    const [, guildId] = interaction.customId.split(":");
    const config = state.guilds[guildId];
    if (!config || interaction.guildId !== guildId) {
      await interaction.reply({ content: "Ovaj panel više nije aktivan.", ephemeral: true });
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
      await interaction.reply({ content: "Ovaj rank više nije dostupan.", ephemeral: true });
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
      await interaction.reply({ content: "Prijava ne postoji ili je obrisana.", ephemeral: true });
    }
    return;
  }

  if (interaction.customId.startsWith("reject_application:")) {
    const application = await getApplicationFromButton(interaction);
    if (application) {
      const config = interaction.guildId ? state.guilds[interaction.guildId] : undefined;
      if (!canProcessApplications(interaction, config)) {
        await interaction.reply({ content: "Samo podešene HC role i administratori mogu odbiti prijavu.", ephemeral: true });
        return;
      }
      await interaction.showModal(buildRejectionModal(application.id));
    } else {
      await interaction.reply({ content: "Prijava ne postoji ili je obrisana.", ephemeral: true });
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
          await interaction.reply({ content: "Prijava ne postoji ili je obrisana.", ephemeral: true });
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
        await interaction.followUp({ content: "Došlo je do greške. Pokušaj ponovo ili javi administratoru.", ephemeral: true })
          .catch(() => undefined);
      } else if (!interaction.replied) {
        await interaction.reply({ content: "Došlo je do greške. Pokušaj ponovo ili javi administratoru.", ephemeral: true })
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