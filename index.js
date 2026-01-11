require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { Low } = require("lowdb");
const { JSONFile } = require("lowdb/node");

const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionsBitField
} = require("discord.js");

/**
 * ✅ WHITELIST (MOD) — Moderasyon komutları SADECE bunlara açık
 */
const MOD_WHITELIST = new Set([
  "811618929779933264",
  "822019430535397437",
  "BURAYA_SENIN_ID" // <-- BUNU DOLDUR
]);

/**
 * DB
 */
const DB_PATH = path.join(__dirname, "db.json");
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "{}", "utf8");

const adapter = new JSONFile(DB_PATH);
const db = new Low(adapter, { guilds: {} });

async function dbInit(guildId) {
  await db.read();
  db.data ||= { guilds: {} };

  db.data.guilds[guildId] ||= {
    modLogChannelId: null,
    warnings: {},
    antiswear: {
      enabled: true,
      action: "delete_warn", // delete_warn | delete | warn_only
      warnLimit: 3,
      timeoutOnLimit: "10m" // warnLimit'e ulaşınca timeout at (bot yetkiliyse)
    }
  };

  await db.write();
  return db.data.guilds[guildId];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseDuration(input) {
  const match = String(input || "").trim().match(/^(\d+)\s*([smhd])$/i);
  if (!match) return null;
  const num = Number(match[1]);
  const unit = match[2].toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return num * mult;
}

async function sendModLog(guild, content) {
  const g = await dbInit(guild.id);
  if (!g.modLogChannelId) return;
  const ch = guild.channels.cache.get(g.modLogChannelId);
  if (ch) ch.send({ content }).catch(() => {});
}

/**
 * Anti küfür listesi (istersen genişletirsin)
 * Not: Çok agresif eşleşme istemiyorsan burayı sade tut.
 */
const BAD_WORDS = [
  "siktir", "amk", "aq", "orospu", "piç", "yarrak", "ananı", "göt", "ibne"
];

function hasBadWord(text) {
  const t = String(text || "").toLowerCase();
  // basit yaklaşım: kelime içi yakalayabilir (istersen word-boundary ekleriz)
  return BAD_WORDS.some(w => t.includes(w));
}

/**
 * Komik ban sebepleri
 */
const FUN_BAN_REASONS = [
  "Fazla karizma (sunucu dengesi bozuldu)",
  "3 kere 'geliyorum' deyip gelmemek",
  "Caps Lock ile konuşma suçu",
  "'Ben adminim' şakası fazla uzadı",
  "Gereksiz dramatik giriş-çıkış yapmak",
  "7/24 'kanka' yazıp hiç konu açmamak",
  "Morali aşırı yükseltmek (yasak)"
];

/**
 * MOD-ONLY komut seti (whitelist zorunlu)
 */
const MOD_ONLY = new Set([
  "setuplog",
  "ban", "unban", "kick", "timeout", "purge",
  "warn", "warnings", "clearwarnings",
  "lock", "unlock", "slowmode", "nick", "role",
  "say",
  "antiswear"
]);

/**
 * SLASH COMMANDS
 */
const commandBuilders = [
  // MOD-ONLY
  new SlashCommandBuilder()
    .setName("setuplog")
    .setDescription("Mod-log kanalını ayarla (mod-only)")
    .addChannelOption(o => o.setName("kanal").setDescription("Log kanalı").setRequired(true)),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban (sebep opsiyonel; boşsa komik sebep DM) (mod-only)")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true))
    .addStringOption(o => o.setName("sebep").setDescription("Sebep (opsiyonel)").setRequired(false))
    .addIntegerOption(o =>
      o.setName("mesaj_sil_gun").setDescription("0-7 gün mesaj sil").setRequired(false).setMinValue(0).setMaxValue(7)
    ),

  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("ID ile unban (mod-only)")
    .addStringOption(o => o.setName("id").setDescription("Kullanıcı ID").setRequired(true))
    .addStringOption(o => o.setName("sebep").setDescription("Sebep (opsiyonel)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick (mod-only)")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true))
    .addStringOption(o => o.setName("sebep").setDescription("Sebep (opsiyonel)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout (10m/2h/1d) (mod-only)")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true))
    .addStringOption(o => o.setName("sure").setDescription("10m/2h/1d").setRequired(true))
    .addStringOption(o => o.setName("sebep").setDescription("Sebep (opsiyonel)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Mesaj sil (1-100) (mod-only)")
    .addIntegerOption(o => o.setName("adet").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Uyarı ver (mod-only)")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true))
    .addStringOption(o => o.setName("sebep").setDescription("Sebep").setRequired(true)),

  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Uyarıları gör (mod-only)")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true)),

  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Uyarıları temizle (mod-only)")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true)),

  new SlashCommandBuilder().setName("lock").setDescription("Kanalı kilitle (mod-only)"),
  new SlashCommandBuilder().setName("unlock").setDescription("Kanalı aç (mod-only)"),

  new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Slowmode (mod-only)")
    .addIntegerOption(o => o.setName("saniye").setDescription("0-21600").setRequired(true).setMinValue(0).setMaxValue(21600)),

  new SlashCommandBuilder()
    .setName("nick")
    .setDescription("Nick değiştir (mod-only)")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true))
    .addStringOption(o => o.setName("isim").setDescription("Yeni nick").setRequired(true)),

  new SlashCommandBuilder()
    .setName("role")
    .setDescription("Rol ekle/çıkar (mod-only)")
    .addStringOption(o =>
      o.setName("islem").setDescription("add/remove").setRequired(true)
        .addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" })
    )
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true))
    .addRoleOption(o => o.setName("rol").setDescription("Rol").setRequired(true)),

  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Bot ağzıyla mesaj at (mod-only)")
    .addStringOption(o => o.setName("mesaj").setDescription("Mesaj").setRequired(true)),

  // Anti küfür ayarı (mod-only)
  new SlashCommandBuilder()
    .setName("antiswear")
    .setDescription("Anti küfür ayarı (mod-only)")
    .addStringOption(o =>
      o.setName("durum").setDescription("on/off").setRequired(true)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" })
    )
    .addStringOption(o =>
      o.setName("aksiyon").setDescription("delete_warn / delete / warn_only").setRequired(false)
        .addChoices(
          { name: "delete_warn", value: "delete_warn" },
          { name: "delete", value: "delete" },
          { name: "warn_only", value: "warn_only" }
        )
    ),

  // FUN (HERKESE AÇIK)
  new SlashCommandBuilder().setName("ping").setDescription("Gecikme göster"),
  new SlashCommandBuilder().setName("coinflip").setDescription("Yazı mı tura mı?"),
  new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Sihirli 8 topu")
    .addStringOption(o => o.setName("soru").setDescription("Sorun").setRequired(true)),
  new SlashCommandBuilder().setName("joke").setDescription("Rastgele kısa şaka"),
  new SlashCommandBuilder()
    .setName("roast")
    .setDescription("Tatlı tatlı kızart")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true)),
  new SlashCommandBuilder()
    .setName("compliment")
    .setDescription("İltifat et")
    .addUserOption(o => o.setName("kisi").setDescription("Kişi").setRequired(true)),
  new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Hızlı anket (👍/👎)")
    .addStringOption(o => o.setName("soru").setDescription("Soru").setRequired(true)),

  // ✅ 5 YENİ EĞLENCE KOMUTU
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Zar at (varsayılan 6)")
    .addIntegerOption(o => o.setName("kenar").setDescription("Örn: 6 / 20").setRequired(false).setMinValue(2).setMaxValue(999)),

  new SlashCommandBuilder()
    .setName("rate")
    .setDescription("Bir şeyi 1-10 puanlar")
    .addStringOption(o => o.setName("sey").setDescription("Neyi puanlayayım?").setRequired(true)),

  new SlashCommandBuilder()
    .setName("fortune")
    .setDescription("Fal kurabiyesi (tamamen sallama)"),

  new SlashCommandBuilder()
    .setName("reverse")
    .setDescription("Yazıyı ters çevirir")
    .addStringOption(o => o.setName("yazi").setDescription("Metin").setRequired(true)),

  new SlashCommandBuilder()
    .setName("emojify")
    .setDescription("Yazıyı emoji manyağı yapar")
    .addStringOption(o => o.setName("yazi").setDescription("Metin").setRequired(true)),

  new SlashCommandBuilder()
    .setName("serverinfo")
    .setDescription("Sunucu bilgisi"),
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Kullanıcı bilgisi")
    .addUserOption(o => o.setName("kisi").setDescription("Opsiyonel").setRequired(false)),
  new SlashCommandBuilder()
    .setName("avatar")
    .setDescription("Avatar")
    .addUserOption(o => o.setName("kisi").setDescription("Opsiyonel").setRequired(false)),
];

const commandsJSON = commandBuilders.map(c => c.toJSON());

async function registerCommandsIfNeeded() {
  if (process.env.REGISTER_COMMANDS !== "true") return;

  const token = process.env.TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !clientId || !guildId) {
    console.log("REGISTER_COMMANDS=true ama TOKEN/CLIENT_ID/GUILD_ID eksik.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("Komutlar yükleniyor...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandsJSON });
    console.log("Komutlar yüklendi ✅");
  } catch (e) {
    console.error("Komut yükleme hatası:", e);
  }
}

/**
 * Client — Anti küfür için messageCreate lazım:
 * GuildMessages + MessageContent gerekiyor.
 */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

client.once("ready", async () => {
  console.log(`✅ winstick online: ${client.user.tag}`);
  client.user.setActivity("winstick | slash komutları");
  await registerCommandsIfNeeded();
});

/**
 * 🔥 Anti küfür (mesaj yakalama)
 */
client.on("messageCreate", async (msg) => {
  try {
    if (!msg.guild) return;
    if (msg.author.bot) return;
    if (!msg.content) return;

    const g = await dbInit(msg.guild.id);
    if (!g.antiswear?.enabled) return;

    // Whitelist modları istersen muaf yap:
    if (MOD_WHITELIST.has(msg.author.id)) return;

    if (!hasBadWord(msg.content)) return;

    // Aksiyonlar
    const action = g.antiswear.action || "delete_warn";

    // delete gerekiyorsa bot izni:
    if ((action === "delete_warn" || action === "delete") &&
        !msg.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      // izin yoksa sadece uyarı say
    } else {
      if (action === "delete_warn" || action === "delete") {
        await msg.delete().catch(() => {});
      }
    }

    // Warn kaydı
    if (action === "delete_warn" || action === "warn_only") {
      g.warnings[msg.author.id] ||= [];
      g.warnings[msg.author.id].push({ at: Date.now(), mod: "ANTISWEAR", reason: "Küfür / argo tespit edildi" });
      await db.write();

      const warnCount = (g.warnings[msg.author.id] || []).length;
      const limit = g.antiswear.warnLimit ?? 3;

      // küçük uyarı mesajı (kendini silsin)
      const warnMsg = await msg.channel.send({
        content: `⚠️ ${msg.author} küfür/argo algılandı. (**${warnCount}/${limit}**)`
      }).catch(() => null);
      if (warnMsg) setTimeout(() => warnMsg.delete().catch(() => {}), 6000);

      // limite ulaşınca timeout (bot yetkiliyse)
      if (warnCount >= limit) {
        const duration = parseDuration(g.antiswear.timeoutOnLimit || "10m");
        if (duration && msg.guild.members.me?.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
          const member = await msg.guild.members.fetch(msg.author.id).catch(() => null);
          if (member) {
            await member.timeout(duration, "Anti küfür: uyarı limiti aşıldı").catch(() => {});
            await sendModLog(msg.guild,
              `⛔ **ANTISWEAR TIMEOUT** | ${msg.author.tag} (${msg.author.id})\n` +
              `⏱ ${g.antiswear.timeoutOnLimit || "10m"} | Limit: ${limit}`
            );
          }
        }
      }
    }

    await sendModLog(msg.guild,
      `🧼 **ANTISWEAR** | ${msg.author.tag} (${msg.author.id})\n` +
      `#${msg.channel.name} | Aksiyon: ${action}`
    );

  } catch (e) {
    console.error("antiswear error:", e);
  }
});

/**
 * Slash commands
 */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  const { commandName, guild } = interaction;
  const isMod = MOD_ONLY.has(commandName);

  // ✅ HAYATİ: HER KOMUTTA ACK -> artık "did not respond" olmaz
  // mod komutları ephemeral, eğlence komutları normal
  await interaction.deferReply({ ephemeral: isMod }).catch(() => {});

  const respond = async (msg) => {
    try { return await interaction.editReply({ content: msg }); } catch {}
  };

  const explainErr = (e) => {
    if (e?.code === 50013) return "❌ Bot yetkisi yok / rol hiyerarşisi düşük. (Bot rolünü üste al + izin ver)";
    if (e?.code === 10007) return "❌ Kullanıcı sunucuda yok.";
    if (e?.message) return `⚠️ Hata: ${e.message}`;
    return "⚠️ Hata oluştu.";
  };

  // ✅ Whitelist kontrolü: mod-only ise kesin şart
  if (isMod && !MOD_WHITELIST.has(interaction.user.id)) {
    return respond("🚫 Yetkin yok. (Bu komut sadece whitelist modlara açık)");
  }

  const me = await guild.members.fetchMe().catch(() => null);

  const botHas = (perm) => me?.permissions.has(perm);
  const canActOnMember = (targetMember) => {
    if (!me || !targetMember) return true;
    if (targetMember.id === guild.ownerId) return false;
    return me.roles.highest.position > targetMember.roles.highest.position;
  };

  try {
    // ===== MOD =====

    if (commandName === "setuplog") {
      const kanal = interaction.options.getChannel("kanal", true);
      const g = await dbInit(guild.id);
      g.modLogChannelId = kanal.id;
      await db.write();
      return respond(`✅ Mod-log kanalı ayarlandı: ${kanal}`);
    }

    if (commandName === "antiswear") {
      const durum = interaction.options.getString("durum", true);
      const aksiyon = interaction.options.getString("aksiyon", false);

      const g = await dbInit(guild.id);
      g.antiswear.enabled = (durum === "on");
      if (aksiyon) g.antiswear.action = aksiyon;
      await db.write();

      return respond(`🧼 Anti küfür: **${g.antiswear.enabled ? "AÇIK" : "KAPALI"}** | Aksiyon: **${g.antiswear.action}**`);
    }

    if (commandName === "warn") {
      const user = interaction.options.getUser("kisi", true);
      const reason = interaction.options.getString("sebep", true);

      const g = await dbInit(guild.id);
      g.warnings[user.id] ||= [];
      g.warnings[user.id].push({ at: Date.now(), mod: interaction.user.id, reason });
      await db.write();

      user.send(`⚠️ **${guild.name}** uyarı.\n👮 ${interaction.user.tag}\n📝 Sebep: ${reason}`).catch(() => {});
      await sendModLog(guild, `⚠️ **WARN** | ${user.tag} (${user.id})\n👮 ${interaction.user.tag}\n📝 ${reason}`);

      return respond(`⚠️ ${user.tag} uyarıldı.`);
    }

    if (commandName === "warnings") {
      const user = interaction.options.getUser("kisi", true);
      const g = await dbInit(guild.id);
      const list = g.warnings[user.id] || [];
      if (list.length === 0) return respond("✅ Bu kişinin uyarısı yok.");

      const lines = list.slice(-10).map((w, i) => {
        const d = new Date(w.at).toLocaleString("tr-TR");
        return `**${i + 1})** ${d} | <@${w.mod}> — ${w.reason}`;
      });

      return respond(`📌 **${user.tag}** uyarıları (son 10):\n${lines.join("\n")}`);
    }

    if (commandName === "clearwarnings") {
      const user = interaction.options.getUser("kisi", true);
      const g = await dbInit(guild.id);
      g.warnings[user.id] = [];
      await db.write();
      await sendModLog(guild, `🧽 **CLEAR WARNINGS** | ${user.tag} (${user.id})\n👮 ${interaction.user.tag}`);
      return respond(`🧽 ${user.tag} uyarıları temizlendi.`);
    }

    if (commandName === "timeout") {
      if (!botHas(PermissionsBitField.Flags.ModerateMembers)) {
        return respond("❌ Botta **Moderate Members** izni yok.");
      }

      const user = interaction.options.getUser("kisi", true);
      const sureStr = interaction.options.getString("sure", true);
      const reason = interaction.options.getString("sebep", false) || "Sebep yok";

      const ms = parseDuration(sureStr);
      if (!ms) return respond("❌ Süre yanlış. Örn: `10m`, `2h`, `1d`");

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return respond("❌ Kişi sunucuda değil.");
      if (!canActOnMember(member)) return respond("❌ Botun rolü hedef kişinin rolünden düşük. (Bot rolünü üste al)");

      await member.timeout(ms, reason);
      user.send(`⏳ **${guild.name}** timeout.\n👮 ${interaction.user.tag}\n⏱ ${sureStr}\n📝 ${reason}`).catch(() => {});
      await sendModLog(guild, `⏳ **TIMEOUT** | ${user.tag} (${user.id})\n👮 ${interaction.user.tag}\n⏱ ${sureStr}\n📝 ${reason}`);

      return respond(`✅ ${user.tag} timeoutlandı. (${sureStr})`);
    }

    if (commandName === "ban") {
      if (!botHas(PermissionsBitField.Flags.BanMembers)) {
        return respond("❌ Botta **Ban Members** izni yok.");
      }

      const user = interaction.options.getUser("kisi", true);
      const reasonRaw = interaction.options.getString("sebep", false);
      const days = interaction.options.getInteger("mesaj_sil_gun", false) ?? 0;

      const funny = pick(FUN_BAN_REASONS);
      const reasonForDm = reasonRaw?.trim() || funny;
      const reasonForAudit = reasonRaw?.trim() || "Sebep girilmedi (komik sebep DM’de).";

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member && !canActOnMember(member)) return respond("❌ Bot rolü hedef rolden düşük. (Bot rolünü üste al)");

      user.send(`🚫 **${guild.name}** ban.\n👮 ${interaction.user.tag}\n📝 Sebep: **${reasonForDm}**`).catch(() => {});
      await guild.members.ban(user.id, { reason: reasonForAudit, deleteMessageSeconds: days * 86400 });

      await sendModLog(guild, `🚫 **BAN** | ${user.tag} (${user.id})\n👮 ${interaction.user.tag}\n📝 ${reasonForAudit}`);
      return respond(`✅ ${user.tag} banlandı.\n📝 DM Sebep: **${reasonForDm}**`);
    }

    if (commandName === "unban") {
      if (!botHas(PermissionsBitField.Flags.BanMembers)) return respond("❌ Botta **Ban Members** izni yok.");

      const id = interaction.options.getString("id", true);
      const reason = interaction.options.getString("sebep", false) || "Sebep yok";

      const bans = await guild.bans.fetch();
      const banInfo = bans.get(id);
      if (!banInfo) return respond("❌ Bu ID banlı değil.");

      await guild.members.unban(id, reason);
      await sendModLog(guild, `✅ **UNBAN** | ${banInfo.user.tag} (${id})\n👮 ${interaction.user.tag}\n📝 ${reason}`);
      return respond(`✅ Unban: **${banInfo.user.tag}**`);
    }

    if (commandName === "kick") {
      if (!botHas(PermissionsBitField.Flags.KickMembers)) return respond("❌ Botta **Kick Members** izni yok.");

      const user = interaction.options.getUser("kisi", true);
      const reason = interaction.options.getString("sebep", false) || "Sebep yok";

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return respond("❌ Kişi sunucuda değil.");
      if (!canActOnMember(member)) return respond("❌ Bot rolü hedef rolden düşük. (Bot rolünü üste al)");

      user.send(`👢 **${guild.name}** kick.\n👮 ${interaction.user.tag}\n📝 ${reason}`).catch(() => {});
      await member.kick(reason);

      await sendModLog(guild, `👢 **KICK** | ${user.tag} (${user.id})\n👮 ${interaction.user.tag}\n📝 ${reason}`);
      return respond(`✅ ${user.tag} kicklendi.`);
    }

    if (commandName === "purge") {
      if (!botHas(PermissionsBitField.Flags.ManageMessages)) return respond("❌ Botta **Manage Messages** izni yok.");

      const adet = interaction.options.getInteger("adet", true);
      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) return respond("❌ Bu kanalda mesaj silinemiyor.");

      const deleted = await channel.bulkDelete(adet, true).catch(() => null);
      if (!deleted) return respond("❌ Mesajlar silinemedi (çok eski olabilir).");

      await sendModLog(guild, `🧹 **PURGE** | #${channel.name}\n👮 ${interaction.user.tag}\n🧾 ${deleted.size} mesaj`);
      return respond(`🧹 ${deleted.size} mesaj silindi.`);
    }

    if (commandName === "lock" || commandName === "unlock") {
      if (!botHas(PermissionsBitField.Flags.ManageChannels)) return respond("❌ Botta **Manage Channels** izni yok.");

      const allow = (commandName === "unlock");
      await interaction.channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: allow });

      await sendModLog(guild, `${allow ? "🔓" : "🔒"} **${allow ? "UNLOCK" : "LOCK"}** | #${interaction.channel.name}\n👮 ${interaction.user.tag}`);
      return respond(allow ? "🔓 Kanal açıldı." : "🔒 Kanal kilitlendi.");
    }

    if (commandName === "slowmode") {
      if (!botHas(PermissionsBitField.Flags.ManageChannels)) return respond("❌ Botta **Manage Channels** izni yok.");

      const sec = interaction.options.getInteger("saniye", true);
      await interaction.channel.setRateLimitPerUser(sec);
      await sendModLog(guild, `🐢 **SLOWMODE** | #${interaction.channel.name}\n👮 ${interaction.user.tag}\n⏱ ${sec}s`);
      return respond(`🐢 Slowmode: **${sec} saniye**`);
    }

    if (commandName === "nick") {
      if (!botHas(PermissionsBitField.Flags.ManageNicknames)) return respond("❌ Botta **Manage Nicknames** izni yok.");

      const user = interaction.options.getUser("kisi", true);
      const name = interaction.options.getString("isim", true);

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return respond("❌ Kişi sunucuda değil.");
      if (!canActOnMember(member)) return respond("❌ Bot rolü hedef rolden düşük. (Bot rolünü üste al)");

      await member.setNickname(name);
      await sendModLog(guild, `🏷️ **NICK** | ${user.tag} (${user.id})\n👮 ${interaction.user.tag}\n➡️ ${name}`);
      return respond(`🏷️ Nick değişti: **${name}**`);
    }

    if (commandName === "role") {
      if (!botHas(PermissionsBitField.Flags.ManageRoles)) return respond("❌ Botta **Manage Roles** izni yok.");

      const islem = interaction.options.getString("islem", true);
      const user = interaction.options.getUser("kisi", true);
      const role = interaction.options.getRole("rol", true);

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) return respond("❌ Kişi sunucuda değil.");

      if (me && me.roles.highest.position <= role.position) {
        return respond("❌ Bot rolü bu rolden düşük. (Bot rolünü üste al)");
      }

      if (islem === "add") await member.roles.add(role);
      else await member.roles.remove(role);

      await sendModLog(guild, `🎭 **ROLE ${islem.toUpperCase()}** | ${user.tag}\n👮 ${interaction.user.tag}\n🎯 ${role.name}`);
      return respond(`🎭 Tamam: **${islem}** → ${user.tag} / ${role.name}`);
    }

    if (commandName === "say") {
      const text = interaction.options.getString("mesaj", true);
      await interaction.channel.send({ content: text });
      return respond("✅ Gönderildi.");
    }

    // ===== FUN =====

    if (commandName === "ping") return respond(`🏓 Pong! **${client.ws.ping}ms**`);
    if (commandName === "coinflip") return respond(`🪙 Sonuç: **${Math.random() < 0.5 ? "Yazı" : "Tura"}**`);

    if (commandName === "8ball") {
      const q = interaction.options.getString("soru", true);
      const answers = ["Evet.", "Hayır.", "Büyük ihtimalle.", "Hiç sanmam.", "Bir daha sor.", "Kesinlikle!", "Şüpheli…", "Aşırı net: evet."];
      return respond(`🎱 **Soru:** ${q}\n**Cevap:** ${pick(answers)}`);
    }

    if (commandName === "joke") {
      const jokes = [
        "Discord niye sessiz? Çünkü herkes AFK'da 😭",
        "Klavye neden üzgün? Çünkü hep tuşlara basıyorlar.",
        "Sunucuda drama azaldı: çünkü winstick online 😎"
      ];
      return respond(`😂 ${pick(jokes)}`);
    }

    if (commandName === "roast") {
      const u = interaction.options.getUser("kisi", true);
      const roasts = [
        `${u} sen konuşunca ping bile yoruluyor 😄`,
        `${u} fikir var ama işlemci ısınmış gibi.`,
        `${u} bugün biraz “şarj %1” enerjisi veriyorsun.`
      ];
      return respond(`🔥 ${pick(roasts)}`);
    }

    if (commandName === "compliment") {
      const u = interaction.options.getUser("kisi", true);
      const comps = [
        `${u} bugün gereksiz iyi vibes 😎`,
        `${u} sen olmasan sunucu “404 üyeler bulunamadı” olurdu.`,
        `${u} moral +10, saygı +20.`
      ];
      return respond(`✨ ${pick(comps)}`);
    }

    if (commandName === "poll") {
      const q = interaction.options.getString("soru", true);
      const msg = await interaction.editReply({ content: `📊 **Anket:** ${q}\n👍 / 👎` });
      await msg.react("👍").catch(() => {});
      await msg.react("👎").catch(() => {});
      return;
    }

    // ✅ 5 yeni komut
    if (commandName === "dice") {
      const sides = interaction.options.getInteger("kenar", false) ?? 6;
      const roll = Math.floor(Math.random() * sides) + 1;
      return respond(`🎲 d${sides} attım: **${roll}**`);
    }

    if (commandName === "rate") {
      const thing = interaction.options.getString("sey", true);
      const score = Math.floor(Math.random() * 10) + 1;
      const comment = pick([
        "fena değil ama biraz geliştirilebilir 😄",
        "aşırı iyi, saygı duydum.",
        "ben bunu görmedim say… ama puan verdim 😎",
        "tam bir klasik.",
        "riskli ama hoş!"
      ]);
      return respond(`⭐ **${thing}** → **${score}/10** (${comment})`);
    }

    if (commandName === "fortune") {
      const fortunes = [
        "Bugün şansın: Wi-Fi çektiği kadar güçlü.",
        "Yakında birisi sana 'kanka' diye başlayıp efsane bir şey isteyecek.",
        "Bugün küçük bir karar büyük bir rahatlık getirecek.",
        "Bir bildirim gelecek… ama spam değil 😄",
        "Sabır + kahkaha = tam isabet."
      ];
      return respond(`🥠 ${pick(fortunes)}`);
    }

    if (commandName === "reverse") {
      const t = interaction.options.getString("yazi", true);
      return respond(`🔁 ${t.split("").reverse().join("")}`);
    }

    if (commandName === "emojify") {
      const t = interaction.options.getString("yazi", true);
      const mapChar = (ch) => {
        const c = ch.toLowerCase();
        if (c >= "a" && c <= "z") return `:regional_indicator_${c}:`;
        if (c === " ") return "   ";
        if (c >= "0" && c <= "9") return `${c}\uFE0F\u20E3`;
        return ch;
      };
      return respond(t.split("").map(mapChar).join(" "));
    }

    if (commandName === "serverinfo") {
      const owner = await guild.fetchOwner().catch(() => null);
      return respond(
        `🏠 **${guild.name}**\n🆔 \`${guild.id}\`\n👥 Üye: **${guild.memberCount}**\n👑 Owner: ${owner ? owner.user.tag : "?"}\n📅 ${guild.createdAt.toLocaleString("tr-TR")}`
      );
    }

    if (commandName === "userinfo") {
      const user = interaction.options.getUser("kisi", false) || interaction.user;
      return respond(`👤 **${user.tag}**\n🆔 \`${user.id}\`\n📅 ${user.createdAt.toLocaleString("tr-TR")}`);
    }

    if (commandName === "avatar") {
      const user = interaction.options.getUser("kisi", false) || interaction.user;
      return respond(`🖼️ ${user.tag} avatar:\n${user.displayAvatarURL({ size: 1024 })}`);
    }

    return respond("⚠️ Komut bulundu ama handler yok (garip).");

  } catch (e) {
    console.error("Komut hatası:", e);
    return respond(explainErr(e));
  }
});

client.login(process.env.TOKEN);
