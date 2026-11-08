const need = (k, def) => { const v = process.env[k] || def; return v; };
const cfg = {
  port: Number(need('PORT', 3000)),
  databaseUrl: need('DATABASE_URL', ''),
  databaseSsl: need('DATABASE_SSL', 'false') === 'true',
  jwtSecret: need('JWT_SECRET', ''),
  tokenHours: Number(need('TOKEN_HOURS', 168)),
  corsOrigins: String(need('CORS_ORIGIN', '')).split(',').map(s => s.trim()).filter(Boolean),
  maxJson: 4 * 1024 * 1024,
  maxFile: 20 * 1024 * 1024
};
cfg.check = () => {
  if (!cfg.databaseUrl) throw new Error('Defina DATABASE_URL.');
  if (cfg.jwtSecret.length < 16) throw new Error('Defina JWT_SECRET com pelo menos 16 caracteres.');
};
module.exports = cfg;
