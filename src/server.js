// src/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import path from "path";
import { fileURLToPath } from "url";

import authRouter, { authenticateMiddleware } from "./auth.js";
import connectionsRouter from "./routes/connections.js";
import queryRouter from "./routes/query.js";
import logsRouter from "./routes/logs.js";
import usersRouter from "./routes/users.js";
import reportsRouter from "./routes/reports.js";
import menuLocalesRouter from "./routes/menuLocales.js";
import articulosRouter from "./routes/articulos.js";
import horariosBaseRouter from "./routes/HorariosBase.js";
import horariosEspecialesRouter from "./routes/horariosEspeciales.js";
import ventasRouter from "./routes/ventas.js";
import actualizacionesRouter from "./routes/actualizaciones.js";
import notificacionesRouter from "./routes/notificaciones.js";
import scheduledTasksRouter from "./routes/scheduledTasks.js";
import vendedoresRouter from "./routes/vendedores.js";
import empresasRouter from "./routes/empresas.js";
import totemsRouter from "./routes/totems.js";
import gestionesRoutes from "./routes/gestiones.js";
import estadosRoutes from "./routes/estados.js";


//import startDailyAlert from "./jobs/dailyAlert.js";
import "./jobs/fixOfflineUpdatesJob.js";
import { initCronJobs } from "./jobs/distibucionAlert.js";
import { initScheduledTaskJob } from "./jobs/scheduledTaskJob.js";
import { tareaCodigosQuemables } from "./jobs/tareaCodigosQuemables.js";
import { totemsStatusJob } from "./jobs/totemsStatusJob.js";
import { iniciarVendedorScheduler } from "./jobs/vendedorScheduler.js";

initScheduledTaskJob();
initCronJobs();
tareaCodigosQuemables();
totemsStatusJob();
iniciarVendedorScheduler();

// Create server
const app = express();

// CORS
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});


// Static file setup (React build only if exists)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
//const buildPath = path.join(__dirname, "../client/build");
const buildPath = path.join(__dirname, "../client/build");

// Serve frontend static build only if folder exists
import fs from "fs";
const serveFrontend = fs.existsSync(buildPath);

if (serveFrontend) {
  console.log("✅ Serviendo frontend desde /client/build");
  app.use(express.static(buildPath));
} else {
  console.log("⚠️ No se encontró carpeta client/build — modo desarrollo backend");
}

// Public routes
app.use("/actualizaciones", actualizacionesRouter);
app.use("/auth", authRouter);

// ✅ SPA fallback (debe ir al final, después de todas las rutas)
if (serveFrontend) {
  app.get(/^(?!\/(auth|connections|query|logs|users|reports|menu-locales|articulos|horarios-base|horarios-especiales|ventas|actualizaciones|notificaciones|scheduled-tasks | vendedores | empresas | totems | gestiones | estados )).*/, (req, res, next) => {
    // Excluir rutas API del backend
    if (
      req.originalUrl.startsWith("/auth") ||
      req.originalUrl.startsWith("/connections") ||
      req.originalUrl.startsWith("/query") ||
      req.originalUrl.startsWith("/logs") ||
      req.originalUrl.startsWith("/users") ||
      req.originalUrl.startsWith("/reports")||
      req.originalUrl.startsWith("/menu-locales") ||
      req.originalUrl.startsWith("/articulos") ||
      req.originalUrl.startsWith("/horarios-base") ||
      req.originalUrl.startsWith("/horarios-especiales") ||
      req.originalUrl.startsWith("/ventas") ||
      req.originalUrl.startsWith("/actualizaciones")||
      req.originalUrl.startsWith("/notificaciones") ||
      req.originalUrl.startsWith("/scheduled-tasks") ||
      req.originalUrl.startsWith("/vendedores") ||
      req.originalUrl.startsWith("/empresas") ||
      req.originalUrl.startsWith("/totems") ||
      req.originalUrl.startsWith("/gestiones") ||
      req.originalUrl.startsWith("/estados")
    ) {
      return next();
    }

    // Servir index.html para React (por ejemplo /login, /admin, etc.)
    res.sendFile(path.join(buildPath, "index.html"));
  });
}

// Protected routes
app.use(authenticateMiddleware);
app.use("/connections", connectionsRouter);
app.use("/query", queryRouter);
app.use("/logs", logsRouter);
app.use("/users", usersRouter);
app.use("/reports", reportsRouter);
app.use("/menu-locales", menuLocalesRouter);
app.use("/articulos", articulosRouter);
app.use("/horarios-base", horariosBaseRouter);
app.use("/horarios-especiales", horariosEspecialesRouter);
app.use("/ventas", ventasRouter);
app.use("/notificaciones", notificacionesRouter);
app.use("/scheduled-tasks", scheduledTasksRouter);
app.use("/vendedores",vendedoresRouter)
app.use("/empresas",empresasRouter)
app.use("/totems",totemsRouter)
app.use("/gestiones",gestionesRoutes)
app.use("/estados",estadosRoutes)

// Cron jobs
//startDailyAlert();

// Run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
