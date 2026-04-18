// ─── Health check server — must start first for deployment ────────────────────
const http = require('http');
const healthServer = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});
healthServer.on('error', err => console.warn('Health check server error:', err.message));
const PORT = process.env.PORT || 3000;
healthServer.listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ─── Constants ───────────────────────────────────────────────────────────────

const MODES = ['Mace', 'Sword', 'Axe', 'Cart', 'UHC', 'Spear-Mace', 'Ely-Mace', 'Crystal'];

const JT_BT_TIERS = ['D-', 'D+', 'C-', 'C+', 'B-', 'B+', 'A-', 'A+', 'S-', 'S+'];
const OT_TIERS    = ['D', 'C', 'B', 'A', 'S'];

// Colors per tier (JT = blue shades, BT = red shades, OT = gold shades)
const JT_COLORS = {
  'D-': 0x003366, 'D+': 0x004080,
  'C-': 0x0059b3, 'C+': 0x0073e6,
  'B-': 0x1a8cff, 'B+': 0x4da6ff,
  'A-': 0x80bfff, 'A+': 0xb3d9ff,
  'S-': 0xcce6ff, 'S+': 0xe6f2ff,
};
const BT_COLORS = {
  'D-': 0x4d0000, 'D+': 0x660000,
  'C-': 0x800000, 'C+': 0x990000,
  'B-': 0xb30000, 'B+': 0xcc0000,
  'A-': 0xe60000, 'A+': 0xff1a1a,
  'S-': 0xff6666, 'S+': 0xffb3b3,
};
const OT_COLORS = {
  'D': 0x4d3800, 'C': 0x806000,
  'B': 0xb38600, 'A': 0xe6ac00,
  'S': 0xffd700,
};

// Tier rank maps (higher index = higher rank)
const OT_RANK    = Object.fromEntries(OT_TIERS.map((t, i) => [t, i]));
const JT_BT_RANK = Object.fromEntries(JT_BT_TIERS.map((t, i) => [t, i]));

const STAFF_ROLES = ['⌜Owner⌟', '⌜Sr-Tester⌟', '⌜Tester⌟', '⌜Jr-Tester⌟', '⌜Testers⌟', '⌜Staff⌟'];
const RESULTS_CHANNEL = '⌜results⌟';
const TICKET_CATEGORY = '⌜Support⌟';

// ─── In-memory state ──────────────────────────────────────────────────────────

// queues: Map<mode, { timeAvailable, players: [{userId, version}], messageId, channelId }>
const queues = new Map();

// activeTests: Map<ticketChannelId, { userId, mode, version, queueMessageId, queueChannelId }>
const activeTests = new Map();

// ─── Role helpers ─────────────────────────────────────────────────────────────

function getRoleName(mode, type, tier) {
  return `${mode} ${type}: ${tier}`;
}

async function findRole(guild, name) {
  return guild.roles.cache.find(r => r.name === name);
}

// ─── Commands definition ──────────────────────────────────────────────────────

const commands = [
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Queue commands')
    .addSubcommand(sub =>
      sub.setName('create')
        .setDescription('Create a queue for a mode')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('Game mode')
            .setRequired(true)
            .addChoices(...MODES.map(m => ({ name: m, value: m })))
        )
        .addStringOption(opt =>
          opt.setName('time_available')
            .setDescription('How long you are available (e.g. 1 hour)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('delete')
        .setDescription('Delete an active queue for a mode')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('Game mode')
            .setRequired(true)
            .addChoices(...MODES.map(m => ({ name: m, value: m })))
        )
    ),

  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Test commands')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a test with the next player in queue')
        .addStringOption(opt =>
          opt.setName('mode')
            .setDescription('Game mode')
            .setRequired(true)
            .addChoices(...MODES.map(m => ({ name: m, value: m })))
        )
    ),

  new SlashCommandBuilder()
    .setName('result')
    .setDescription('Submit a test result and assign roles')
    .addUserOption(opt =>
      opt.setName('player')
        .setDescription('The player being tested')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('ot_tier')
        .setDescription('Overall Tier')
        .setRequired(true)
        .addChoices(...OT_TIERS.map(t => ({ name: t, value: t })))
    )
    .addStringOption(opt =>
      opt.setName('jt_bt_tier')
        .setDescription('Java Tier or Bedrock Tier (based on player version)')
        .setRequired(true)
        .addChoices(...JT_BT_TIERS.map(t => ({ name: t, value: t })))
    ),

  new SlashCommandBuilder()
    .setName('setup-roles')
    .setDescription('Auto-generate all 200 tier roles with colors and display separately'),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a player\'s full tier breakdown across all modes')
    .addUserOption(opt =>
      opt.setName('player')
        .setDescription('Player to look up (defaults to yourself)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top-ranked players for a mode')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Game mode')
        .setRequired(true)
        .addChoices(...MODES.map(m => ({ name: m, value: m })))
    )
    .addStringOption(opt =>
      opt.setName('type')
        .setDescription('Tier type to display (default: OT)')
        .setRequired(false)
        .addChoices(
          { name: 'OT (Overall Tier)', value: 'OT' },
          { name: 'JT (Java Tier)', value: 'JT' },
          { name: 'BT (Bedrock Tier)', value: 'BT' },
        )
    ),
].map(cmd => cmd.toJSON());

// ─── Register commands ────────────────────────────────────────────────────────

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_SECRET);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ─── Permission check ─────────────────────────────────────────────────────────

function hasStaffRole(member) {
  if (member.guild.ownerId === member.id) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => STAFF_ROLES.includes(r.name));
}

// ─── Event: ready ─────────────────────────────────────────────────────────────

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ─── Event: interactionCreate ─────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: 'An error occurred while processing this interaction.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply(msg);
      }
    } catch {
      // interaction already expired — nothing to do
    }
  }
});

// ─── Command handler ──────────────────────────────────────────────────────────

async function handleCommand(interaction) {
  const { commandName } = interaction;

  if (commandName === 'queue') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') await handleQueueCreate(interaction);
    if (sub === 'delete') await handleQueueDelete(interaction);
  }

  if (commandName === 'test') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'start') await handleTestStart(interaction);
  }

  if (commandName === 'result') await handleResult(interaction);
  if (commandName === 'setup-roles') await handleSetupRoles(interaction);
  if (commandName === 'profile') await handleProfile(interaction);
  if (commandName === 'leaderboard') await handleLeaderboard(interaction);
}

// ─── /queue create ────────────────────────────────────────────────────────────

async function handleQueueCreate(interaction) {
  const mode = interaction.options.getString('mode');
  const time = interaction.options.getString('time_available');

  if (queues.has(mode)) {
    return interaction.reply({ content: `A queue for **${mode}** already exists.`, flags: MessageFlags.Ephemeral });
  }

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${mode} Queue`)
    .setColor(0x5865f2)
    .setDescription(`**Time Available:** ${time}\n\n**Players in queue:** None yet\n\nClick a button below to join or leave.`);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`queue_join_${mode}`).setLabel('✅ Join').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`queue_leave_${mode}`).setLabel('❌ Leave').setStyle(ButtonStyle.Danger),
  );

  const { resource } = await interaction.reply({ embeds: [embed], components: [row], withResponse: true });
  const msg = resource.message;

  queues.set(mode, {
    timeAvailable: time,
    players: [],
    messageId: msg.id,
    channelId: interaction.channelId,
  });
}

// ─── /queue delete ────────────────────────────────────────────────────────────

async function handleQueueDelete(interaction) {
  if (!hasStaffRole(interaction.member)) {
    return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
  }

  const mode = interaction.options.getString('mode');
  const queue = queues.get(mode);

  if (!queue) {
    return interaction.reply({ content: `There is no active queue for **${mode}**.`, flags: MessageFlags.Ephemeral });
  }

  // Delete the original queue embed message
  try {
    const channel = await interaction.client.channels.fetch(queue.channelId);
    const msg = await channel.messages.fetch(queue.messageId);
    await msg.delete();
  } catch (err) {
    console.warn(`Could not delete queue message for ${mode}:`, err.message);
  }

  queues.delete(mode);
  await interaction.reply({ content: `The **${mode}** queue has been deleted.`, flags: MessageFlags.Ephemeral });
}

// ─── Button handler ───────────────────────────────────────────────────────────

async function handleButton(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('queue_join_')) {
    const mode = customId.replace('queue_join_', '');
    await handleQueueJoin(interaction, mode);
  } else if (customId.startsWith('queue_leave_')) {
    const mode = customId.replace('queue_leave_', '');
    await handleQueueLeave(interaction, mode);
  } else if (customId.startsWith('version_java_')) {
    const mode = customId.replace('version_java_', '');
    await finalizeJoin(interaction, mode, 'Java');
  } else if (customId.startsWith('version_bedrock_')) {
    const mode = customId.replace('version_bedrock_', '');
    await finalizeJoin(interaction, mode, 'Bedrock');
  }
}

async function handleQueueJoin(interaction, mode) {
  const queue = queues.get(mode);
  if (!queue) return interaction.reply({ content: `No active queue for **${mode}**.`, flags: MessageFlags.Ephemeral });

  if (queue.players.find(p => p.userId === interaction.user.id)) {
    return interaction.reply({ content: 'You are already in this queue.', flags: MessageFlags.Ephemeral });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`version_java_${mode}`).setLabel('☕ Java').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`version_bedrock_${mode}`).setLabel('🪨 Bedrock').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ content: 'Pick your version:', components: [row], flags: MessageFlags.Ephemeral });
}

async function finalizeJoin(interaction, mode, version) {
  const queue = queues.get(mode);
  if (!queue) return interaction.update({ content: 'Queue no longer exists.', components: [] });

  if (queue.players.find(p => p.userId === interaction.user.id)) {
    return interaction.update({ content: 'You are already in this queue.', components: [] });
  }

  queue.players.push({ userId: interaction.user.id, version });
  await interaction.update({ content: `You joined the **${mode}** queue as **${version}**.`, components: [] });
  await updateQueueEmbed(interaction.client, mode);
}

async function handleQueueLeave(interaction, mode) {
  const queue = queues.get(mode);
  if (!queue) return interaction.reply({ content: `No active queue for **${mode}**.`, flags: MessageFlags.Ephemeral });

  const idx = queue.players.findIndex(p => p.userId === interaction.user.id);
  if (idx === -1) return interaction.reply({ content: 'You are not in this queue.', flags: MessageFlags.Ephemeral });

  queue.players.splice(idx, 1);
  await interaction.reply({ content: `You left the **${mode}** queue.`, flags: MessageFlags.Ephemeral });
  await updateQueueEmbed(interaction.client, mode);
}

async function updateQueueEmbed(client, mode) {
  const queue = queues.get(mode);
  if (!queue) return;

  try {
    const channel = await client.channels.fetch(queue.channelId);
    const msg = await channel.messages.fetch(queue.messageId);

    const playerList = queue.players.length === 0
      ? 'None yet'
      : queue.players.map((p, i) => `${i + 1}. <@${p.userId}> (${p.version})`).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`📋 ${mode} Queue`)
      .setColor(0x5865f2)
      .setDescription(`**Time Available:** ${queue.timeAvailable}\n\n**Players in queue:**\n${playerList}\n\nClick a button below to join or leave.`);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`queue_join_${mode}`).setLabel('✅ Join').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`queue_leave_${mode}`).setLabel('❌ Leave').setStyle(ButtonStyle.Danger),
    );

    await msg.edit({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error('Failed to update queue embed:', err);
  }
}

// ─── /test start ──────────────────────────────────────────────────────────────

async function handleTestStart(interaction) {
  if (!hasStaffRole(interaction.member)) {
    return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
  }

  const mode = interaction.options.getString('mode');
  const queue = queues.get(mode);

  if (!queue || queue.players.length === 0) {
    return interaction.reply({ content: `No players in the **${mode}** queue.`, flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const next = queue.players.shift();
  await updateQueueEmbed(interaction.client, mode);

  const guild = interaction.guild;

  // Find or use ticket category
  let category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === TICKET_CATEGORY
  );

  let ticketChannel;
  try {
    const targetMember = await guild.members.fetch(next.userId);
    ticketChannel = await guild.channels.create({
      name: `test-${targetMember.user.username}`,
      type: ChannelType.GuildText,
      parent: category?.id ?? null,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: ['ViewChannel'] },
        { id: next.userId, allow: ['ViewChannel', 'SendMessages'] },
        { id: interaction.user.id, allow: ['ViewChannel', 'SendMessages'] },
        { id: interaction.client.user.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels'] },
      ],
    });
  } catch (err) {
    console.error('Failed to create ticket channel:', err);
    queue.players.unshift(next);
    await updateQueueEmbed(interaction.client, mode);
    return interaction.editReply({ content: 'Failed to create ticket channel. Make sure the bot has permission to manage channels.' });
  }

  activeTests.set(ticketChannel.id, {
    userId: next.userId,
    version: next.version,
    mode,
    queueMessageId: queue.messageId,
    queueChannelId: queue.channelId,
  });

  const embed = new EmbedBuilder()
    .setTitle(`🧪 ${mode} Test`)
    .setColor(0xffa500)
    .addFields(
      { name: 'Player', value: `<@${next.userId}>`, inline: true },
      { name: 'Version', value: next.version, inline: true },
      { name: 'Mode', value: mode, inline: true },
      { name: 'Tester', value: `<@${interaction.user.id}>`, inline: true },
    )
    .setDescription('Use `/result` in this channel when the test is complete.');

  await ticketChannel.send({ content: `<@${next.userId}> <@${interaction.user.id}>`, embeds: [embed] });
  await interaction.editReply({ content: `Ticket created: ${ticketChannel}` });
}

// ─── /result ──────────────────────────────────────────────────────────────────

async function handleResult(interaction) {
  if (!hasStaffRole(interaction.member)) {
    return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
  }

  const testData = activeTests.get(interaction.channelId);
  if (!testData) {
    return interaction.reply({ content: 'This command must be used inside a test ticket channel.', flags: MessageFlags.Ephemeral });
  }

  const player = interaction.options.getUser('player');
  const otTier = interaction.options.getString('ot_tier');
  const jtBtTier = interaction.options.getString('jt_bt_tier');

  await interaction.deferReply();

  const guild = interaction.guild;
  const member = await guild.members.fetch(player.id);
  const mode = testData.mode;
  const version = testData.version;
  const jtBtType = version === 'Java' ? 'JT' : 'BT';

  // Remove any existing OT roles for this mode before assigning new one
  for (const tier of OT_TIERS) {
    const role = guild.roles.cache.find(r => r.name === getRoleName(mode, 'OT', tier));
    if (role && member.roles.cache.has(role.id)) await member.roles.remove(role);
  }
  // Remove any existing JT/BT roles for this mode before assigning new one
  for (const tier of JT_BT_TIERS) {
    const role = guild.roles.cache.find(r => r.name === getRoleName(mode, jtBtType, tier));
    if (role && member.roles.cache.has(role.id)) await member.roles.remove(role);
  }

  // Assign new OT role
  const otRoleName = getRoleName(mode, 'OT', otTier);
  const otRole = guild.roles.cache.find(r => r.name === otRoleName);
  if (otRole) await member.roles.add(otRole);

  // Assign new JT or BT role
  const jtBtRoleName = getRoleName(mode, jtBtType, jtBtTier);
  const jtBtRole = guild.roles.cache.find(r => r.name === jtBtRoleName);
  if (jtBtRole) await member.roles.add(jtBtRole);

  // Send result to results channel
  const resultsChannel = guild.channels.cache.find(c => c.name === RESULTS_CHANNEL);
  if (resultsChannel) {
    const embed = new EmbedBuilder()
      .setTitle('📊 Test Result')
      .setColor(0x57f287)
      .addFields(
        { name: 'Player', value: `<@${player.id}>`, inline: true },
        { name: 'Mode', value: mode, inline: true },
        { name: 'Version', value: version, inline: true },
        { name: 'OT', value: otRoleName, inline: true },
        { name: jtBtType, value: jtBtRoleName, inline: true },
        { name: 'Tested by', value: `<@${interaction.user.id}>`, inline: true },
      );
    await resultsChannel.send({ embeds: [embed] }).catch(err => console.error('Failed to send result embed:', err));
  }

  await interaction.editReply({ content: `Result submitted. Closing ticket...` });

  // Delete ticket after short delay
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
  activeTests.delete(interaction.channelId);
}

// ─── /setup-roles ─────────────────────────────────────────────────────────────

async function handleSetupRoles(interaction) {
  if (!hasStaffRole(interaction.member)) {
    return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({ content: '⚙️ Creating all tier roles... This may take a while (200 roles).', flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  let created = 0;
  let skipped = 0;

  for (const mode of MODES) {
    // OT roles
    for (const tier of OT_TIERS) {
      const name = getRoleName(mode, 'OT', tier);
      const exists = guild.roles.cache.find(r => r.name === name);
      if (!exists) {
        await guild.roles.create({
          name,
          colors: [OT_COLORS[tier]],
          hoist: true,
          mentionable: false,
          reason: 'Auto setup by RT Tiers Bot',
        });
        created++;
        await delay(300);
      } else {
        skipped++;
      }
    }

    // JT roles
    for (const tier of JT_BT_TIERS) {
      const name = getRoleName(mode, 'JT', tier);
      const exists = guild.roles.cache.find(r => r.name === name);
      if (!exists) {
        await guild.roles.create({
          name,
          colors: [JT_COLORS[tier]],
          hoist: true,
          mentionable: false,
          reason: 'Auto setup by RT Tiers Bot',
        });
        created++;
        await delay(300);
      } else {
        skipped++;
      }
    }

    // BT roles
    for (const tier of JT_BT_TIERS) {
      const name = getRoleName(mode, 'BT', tier);
      const exists = guild.roles.cache.find(r => r.name === name);
      if (!exists) {
        await guild.roles.create({
          name,
          colors: [BT_COLORS[tier]],
          hoist: true,
          mentionable: false,
          reason: 'Auto setup by RT Tiers Bot',
        });
        created++;
        await delay(300);
      } else {
        skipped++;
      }
    }
  }

  await interaction.followUp({
    content: `✅ Done! Created **${created}** roles, skipped **${skipped}** (already existed).`,
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /profile ─────────────────────────────────────────────────────────────────

async function handleProfile(interaction) {
  const targetUser = interaction.options.getUser('player') ?? interaction.user;

  await interaction.deferReply();

  const guild = interaction.guild;
  let member;
  try {
    member = await guild.members.fetch(targetUser.id);
  } catch {
    return interaction.editReply({ content: `Could not find **${targetUser.username}** in this server.` });
  }

  // Collect tier data per mode
  const modeResults = [];

  for (const mode of MODES) {
    let otTier = null;
    let jtTier = null;
    let btTier = null;

    // Find highest OT tier held
    for (const tier of OT_TIERS) {
      if (member.roles.cache.some(r => r.name === getRoleName(mode, 'OT', tier))) {
        otTier = tier;
      }
    }
    // Find highest JT tier held
    for (const tier of JT_BT_TIERS) {
      if (member.roles.cache.some(r => r.name === getRoleName(mode, 'JT', tier))) {
        jtTier = tier;
      }
    }
    // Find highest BT tier held
    for (const tier of JT_BT_TIERS) {
      if (member.roles.cache.some(r => r.name === getRoleName(mode, 'BT', tier))) {
        btTier = tier;
      }
    }

    if (otTier || jtTier || btTier) {
      modeResults.push({ mode, otTier, jtTier, btTier });
    }
  }

  if (modeResults.length === 0) {
    return interaction.editReply({
      content: `**${targetUser.username}** has not been assigned any tier roles yet.`,
    });
  }

  // Pick embed color: gold if any OT tier, otherwise blurple
  const topOT = modeResults.find(r => r.otTier);
  const embedColor = topOT ? OT_COLORS[topOT.otTier] : 0x5865f2;

  const fields = modeResults.map(({ mode, otTier, jtTier, btTier }) => {
    const parts = [];
    if (otTier) parts.push(`OT: **${otTier}**`);
    if (jtTier) parts.push(`JT: **${jtTier}**`);
    if (btTier) parts.push(`BT: **${btTier}**`);
    return { name: mode, value: parts.join('  |  '), inline: true };
  });

  const totalModes = modeResults.length;
  const highestOT  = modeResults.reduce((best, r) => {
    if (!r.otTier) return best;
    return (!best || OT_RANK[r.otTier] > OT_RANK[best]) ? r.otTier : best;
  }, null);

  const embed = new EmbedBuilder()
    .setTitle(`📋 ${targetUser.username}'s Tier Profile`)
    .setColor(embedColor)
    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
    .addFields(...fields)
    .setFooter({
      text: `Tested in ${totalModes} mode${totalModes !== 1 ? 's' : ''}${highestOT ? `  •  Best OT: ${highestOT}` : ''}`,
    })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ─── /leaderboard ─────────────────────────────────────────────────────────────

const TYPE_COLORS = { OT: 0xffd700, JT: 0x4da6ff, BT: 0xcc0000 };
const TYPE_LABELS = { OT: 'Overall Tier', JT: 'Java Tier', BT: 'Bedrock Tier' };
const TYPE_TIERS  = { OT: OT_TIERS, JT: JT_BT_TIERS, BT: JT_BT_TIERS };
const TYPE_RANKS  = { OT: OT_RANK, JT: JT_BT_RANK, BT: JT_BT_RANK };

const TIER_MEDALS = ['🥇', '🥈', '🥉'];

async function handleLeaderboard(interaction) {
  const mode = interaction.options.getString('mode');
  const type = interaction.options.getString('type') ?? 'OT';

  await interaction.deferReply();

  const guild = interaction.guild;

  // Fetch all members so role caches are populated
  await guild.members.fetch();

  const tiers = TYPE_TIERS[type];
  const rankMap = TYPE_RANKS[type];

  // Build a list of { member, tier, rank } for everyone who has a role for this mode+type
  const entries = [];

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;

    let bestRank = -1;
    let bestTier = null;

    for (const tier of tiers) {
      const roleName = getRoleName(mode, type, tier);
      if (member.roles.cache.some(r => r.name === roleName)) {
        const rank = rankMap[tier];
        if (rank > bestRank) {
          bestRank = rank;
          bestTier = tier;
        }
      }
    }

    if (bestTier !== null) {
      entries.push({ member, tier: bestTier, rank: bestRank });
    }
  }

  if (entries.length === 0) {
    return interaction.editReply({
      content: `No players have a **${mode} ${TYPE_LABELS[type]}** role yet.`,
    });
  }

  // Sort highest rank first, then alphabetically by username
  entries.sort((a, b) => b.rank - a.rank || a.member.user.username.localeCompare(b.member.user.username));

  const top = entries.slice(0, 20);

  const lines = top.map((entry, i) => {
    const medal = TIER_MEDALS[i] ?? `**${i + 1}.**`;
    return `${medal} <@${entry.member.id}> — **${entry.tier}**`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🏆 ${mode} Leaderboard — ${TYPE_LABELS[type]}`)
    .setColor(TYPE_COLORS[type])
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${entries.length} ranked player${entries.length !== 1 ? 's' : ''} total` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_BOT_SECRET);
