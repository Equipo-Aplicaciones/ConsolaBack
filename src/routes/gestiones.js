import express from "express";
import db from "../db/adminDb.js";
import { allowRoles } from "../middleware/roleMiddleware.js";

const router = express.Router();

/* =========================================================
   HELPERS
========================================================= */

async function obtenerEstado(grupo, codigo, trx = db) {
  return trx("estados")
    .where({ grupo, codigo, activo: true })
    .first();
}

async function obtenerGestionPermitida(id, user, trx = db) {
  const query = trx("gestiones").where({ id });

  if (user.role === "N1") {
    query.where("encargado_id", user.id);
  }

  return query.first();
}

/* =========================================================
   GET /gestiones
   LISTADO GENERAL

   Admin / N2:
   - Ven todas las gestiones.

   N1:
   - Solo ve las gestiones donde es encargado.

   Filtros:
   ?estado=PENDIENTE
   ?empresa_id=2
   ?desde=2026-08-01
   ?hasta=2026-08-31
   ?search=kds
========================================================= */

router.get("/", allowRoles("Admin", "N1", "N2"),async (req, res) => {
    try {
      const { estado, empresa_id, desde, hasta, search } = req.query;

      const query = db("gestiones as g")
        .leftJoin("estados as e", "e.id", "g.estado_id")
        .leftJoin("users as u", "u.id", "g.creado_por")
        .leftJoin("users as ue", "ue.id","g.encargado_id")
        .select(
          "g.id",
          "g.nombre",
          "g.descripcion",
          "g.version",
          "g.fecha_inicio",
          "g.fecha_fin",
          "g.estado_id",
          "e.codigo as estado_codigo",
          "e.nombre as estado_nombre",
          "g.motivo_suspension",
          "g.suspendida_at",
          "g.creado_por",
          "u.full_name as creado_por_nombre",
          "g.encargado_id",
          "ue.full_name as encargado_nombre",
          "g.created_at",
          "g.updated_at")
        .orderBy( "g.fecha_inicio", "desc" )
        .orderBy( "g.id", "desc" );

      /*
       N1 solamente puede consultar
       las gestiones que tiene asignadas.
      */

      if (req.user.role === "N1") {
        query.where("g.encargado_id", req.user.id);
      }

      /* =========================
         FILTRO ESTADO
      ========================= */

      if (estado) {
        query.where(
          "e.codigo",
          String(estado)
            .trim()
            .toUpperCase()
        );
      }

      /* =========================
         FILTRO EMPRESA
      ========================= */

      if (empresa_id) {
        const empresaId =
          Number(empresa_id);

        if (
          !Number.isInteger(
            empresaId
          )
        ) {
          return res
            .status(400)
            .json({
              error:
                "empresa_id no válido"
            });
        }

        query.whereExists(
          function () {
            this.select(
              db.raw("1")
            )
              .from(
                "gestiones_locales as gl_empresa"
              )
              .join(
                "connections as c_empresa",
                "c_empresa.id",
                "gl_empresa.connection_id"
              )
              .whereRaw(
                "gl_empresa.gestion_id = g.id"
              )
              .where(
                "c_empresa.empresa_id",
                empresaId
              );
          }
        );
      }

      /* =========================
         FILTRO FECHAS
      ========================= */

      if (desde) {
        query.where(
          "g.fecha_inicio",
          ">=",
          desde
        );
      }

      if (hasta) {
        query.where(
          "g.fecha_inicio",
          "<=",
          hasta
        );
      }

      /* =========================
         BUSCADOR
      ========================= */

      if (search?.trim()) {
        const texto =
          search.trim();

        query.where(
          builder => {
            builder
              .whereILike(
                "g.nombre",
                `%${texto}%`
              )
              .orWhereILike(
                "g.descripcion",
                `%${texto}%`
              )
              .orWhereILike(
                "g.version",
                `%${texto}%`
              );
          }
        );
      }

      const gestiones =
        await query;

      if (
        !gestiones.length
      ) {
        return res.json([]);
      }

      const ids =
        gestiones.map(
          gestion =>
            gestion.id
        );

      /* =====================================================
         RESUMEN DE ESTADOS POR LOCAL
      ===================================================== */

      const resumenLocales =
        await db(
          "gestiones_locales as gl"
        )
          .leftJoin(
            "estados as e",
            "e.id",
            "gl.estado_id"
          )
          .select(
            "gl.gestion_id",
            "e.codigo as estado_codigo"
          )
          .count(
            "* as total"
          )
          .whereIn(
            "gl.gestion_id",
            ids
          )
          .groupBy(
            "gl.gestion_id",
            "e.codigo"
          );

      const mapaResumen = {};

      for (
        const row
        of resumenLocales
      ) {
        const gestionId =
          String(
            row.gestion_id
          );

        if (
          !mapaResumen[
            gestionId
          ]
        ) {
          mapaResumen[
            gestionId
          ] = {
            total: 0,
            terminado: 0,
            pendiente: 0,
            no_aplicado: 0,
            no_aplica: 0
          };
        }

        const cantidad =
          Number(
            row.total
          );

        mapaResumen[
          gestionId
        ].total +=
          cantidad;

        switch (
          row.estado_codigo
        ) {
          case "TERMINADO":
            mapaResumen[
              gestionId
            ].terminado +=
              cantidad;
            break;

          case "PENDIENTE":
            mapaResumen[
              gestionId
            ].pendiente +=
              cantidad;
            break;

          case "NO_APLICADO":
            mapaResumen[
              gestionId
            ].no_aplicado +=
              cantidad;
            break;

          case "NO_APLICA":
            mapaResumen[
              gestionId
            ].no_aplica +=
              cantidad;
            break;

          default:
            break;
        }
      }

      /* =====================================================
         EMPRESAS QUE PARTICIPAN EN CADA GESTIÓN
      ===================================================== */

      const empresasGestiones =
        await db(
          "gestiones_locales as gl"
        )
          .join(
            "connections as c",
            "c.id",
            "gl.connection_id"
          )
          .select(
            "gl.gestion_id",
            "c.empresa_id"
          )
          .whereIn(
            "gl.gestion_id",
            ids
          )
          .whereNotNull(
            "c.empresa_id"
          )
          .groupBy(
            "gl.gestion_id",
            "c.empresa_id"
          )
          .orderBy(
            "c.empresa_id",
            "asc"
          );

      const mapaEmpresas = {};

      for (
        const row
        of empresasGestiones
      ) {
        const gestionId =
          String(
            row.gestion_id
          );

        if (
          !mapaEmpresas[
            gestionId
          ]
        ) {
          mapaEmpresas[
            gestionId
          ] = [];
        }

        mapaEmpresas[
          gestionId
        ].push(
          Number(
            row.empresa_id
          )
        );
      }

      /* =====================================================
         RESULTADO
      ===================================================== */

      const resultado =
        gestiones.map(
          gestion => ({
            ...gestion,
            empresas:
              mapaEmpresas[
                String(
                  gestion.id
                )
              ] ?? [],
            resumen:
              mapaResumen[
                String(
                  gestion.id
                )
              ] ?? {
                total: 0,
                terminado: 0,
                pendiente: 0,
                no_aplicado: 0,
                no_aplica: 0
              }
          })
        );

      res.json(
        resultado
      );

    } catch (error) {
      console.error(
        "Error obteniendo gestiones:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error obteniendo gestiones"
        });
    }
  }
);

/* =========================================================
   GET /gestiones/usuarios/encargados

   Solo Admin y N2.

   Devuelve usuarios N1, N2 y Admin disponibles
   para ser asignados como encargados.
========================================================= */

router.get("/usuarios/encargados",allowRoles("Admin","N2"),async (req, res) => {
    try {
      const usuarios =
        await db("users")
          .select(
            "id",
            "full_name",
            "role"
          )
          .whereIn(
            "role",
            ["N1", "N2", "Admin"]
          )
          .orderBy(
            "full_name",
            "asc"
          );

      res.json(
        usuarios
      );

    } catch (error) {
      console.error(
        "Error obteniendo encargados:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error obteniendo usuarios encargados"
        });
    }
  }
);

/* =========================================================
   PUT /gestiones/:id/encargado

   Solo Admin y N2.

   BODY:
   {
     encargado_id: 10
   }
========================================================= */

router.put("/:id/encargado",allowRoles("Admin", "N2"), async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        encargado_id
      } = req.body;

      if (
        !encargado_id
      ) {
        return res
          .status(400)
          .json({
            error:
              "Debe seleccionar un encargado"
          });
      }

      const gestion =
        await db(
          "gestiones"
        )
          .where({
            id
          })
          .first();

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const usuario =
        await db(
          "users"
        )
          .where(
            "id",
            encargado_id
          )
          .whereIn(
            "role",
            ["N1", "N2", "Admin"]
          )
          .first();

      if (!usuario) {
        return res
          .status(400)
          .json({
            error:
              "El encargado seleccionado no es válido"
          });
      }

      await db(
        "gestiones"
      )
        .where({
          id
        })
        .update({
          encargado_id:
            usuario.id,
          updated_at:
            db.fn.now()
        });

      res.json({
        message:
          "Encargado asignado correctamente",
        encargado_id:
          usuario.id,
        encargado_nombre:
          usuario.full_name
      });

    } catch (error) {
      console.error(
        "Error asignando encargado:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error asignando encargado"
        });
    }
  }
);

/* =========================================================
   GET /gestiones/:id
   DETALLE DE UNA GESTIÓN

   Admin / N2:
   - Pueden consultar cualquiera.

   N1:
   - Solo puede consultar una gestión
     si es su encargado.
========================================================= */

router.get("/:id", allowRoles("Admin", "N1", "N2"),async (req, res) => {
    try {
      const { id } =
        req.params;

      const gestion =
        await db(
          "gestiones as g"
        )
          .leftJoin(
            "estados as e",
            "e.id",
            "g.estado_id"
          )
          .leftJoin(
            "users as u",
            "u.id",
            "g.creado_por"
          )
          .leftJoin(
            "users as ue",
            "ue.id",
            "g.encargado_id"
          )
          .select(
            "g.id",
            "g.nombre",
            "g.descripcion",
            "g.version",
            "g.fecha_inicio",
            "g.fecha_fin",
            "g.estado_id",
            "e.codigo as estado_codigo",
            "e.nombre as estado_nombre",
            "g.motivo_suspension",
            "g.suspendida_at",
            "g.creado_por",
            "u.full_name as creado_por_nombre",
            "g.encargado_id",
            "ue.full_name as encargado_nombre",
            "g.created_at",
            "g.updated_at"
          )
          .where(
            "g.id",
            id
          )
          .modify(
            query => {
              if (
                req.user
                  .role ===
                "N1"
              ) {
                query.where(
                  "g.encargado_id",
                  req.user.id
                );
              }
            }
          )
          .first();

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const locales =
        await db(
          "gestiones_locales as gl"
        )
          .join(
            "connections as c",
            "c.id",
            "gl.connection_id"
          )
          .leftJoin(
            "estados as e",
            "e.id",
            "gl.estado_id"
          )
          .leftJoin(
            "users as u",
            "u.id",
            "gl.actualizado_por"
          )
          .select(
            "gl.id",
            "gl.connection_id",
            "c.empresa_id",
            "c.codLocal",
            "c.name as nombre_local",
            "c.activo as local_activo",
            "gl.estado_id",
            "e.codigo as estado_codigo",
            "e.nombre as estado_nombre",
            "gl.comentario",
            "gl.fecha_aplicacion",
            "gl.actualizado_por",
            "u.full_name as actualizado_por_nombre",
            "gl.created_at",
            "gl.updated_at"
          )
          .where(
            "gl.gestion_id",
            id
          )
          .orderBy(
            "c.empresa_id",
            "asc"
          )
          .orderBy(
            "c.codLocal",
            "asc"
          );

      const empresas = [
        ...new Set(
          locales
            .map(
              local =>
                local.empresa_id
            )
            .filter(
              empresaId =>
                empresaId !==
                  null &&
                empresaId !==
                  undefined
            )
            .map(
              Number
            )
        )
      ];

      res.json({
        ...gestion,
        empresas,
        locales
      });

    } catch (error) {
      console.error(
        "Error obteniendo gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error obteniendo gestión"
        });
    }
  }
);

/* =========================================================
   POST /gestiones
   CREAR GESTIÓN

   Solo Admin y N2.

   BODY:
   {
     nombre,
     descripcion,
     version,
     fecha_inicio,
     connection_ids: [1,2,3]
   }
========================================================= */

router.post("/",allowRoles("Admin","N2"), async (req, res) => {
    const trx =
      await db.transaction();

    try {
      const {
        nombre,
        descripcion,
        version,
        fecha_inicio,
        connection_ids
      } = req.body;

      if (
        !nombre?.trim()
      ) {
        await trx.rollback();

        return res
          .status(400)
          .json({
            error:
              "El nombre es obligatorio"
          });
      }

      if (
        !Array.isArray(
          connection_ids
        ) ||
        !connection_ids.length
      ) {
        await trx.rollback();

        return res
          .status(400)
          .json({
            error:
              "Debe seleccionar al menos un local"
          });
      }

      const idsLocales = [
        ...new Set(
          connection_ids
            .map(Number)
            .filter(
              value =>
                Number.isInteger(
                  value
                ) &&
                value > 0
            )
        )
      ];

      if (
        !idsLocales.length
      ) {
        await trx.rollback();

        return res
          .status(400)
          .json({
            error:
              "Los locales seleccionados no son válidos"
          });
      }

      const localesValidos =
        await trx(
          "connections"
        )
          .select(
            "id",
            "empresa_id",
            "codLocal",
            "name"
          )
          .whereIn(
            "id",
            idsLocales
          );

      if (
        localesValidos
          .length !==
        idsLocales.length
      ) {
        await trx.rollback();

        return res
          .status(400)
          .json({
            error:
              "Uno o más locales seleccionados no existen"
          });
      }

      const empresas = [
        ...new Set(
          localesValidos
            .map(
              local =>
                local.empresa_id
            )
            .filter(
              empresaId =>
                empresaId !==
                  null &&
                empresaId !==
                  undefined
            )
            .map(
              Number
            )
        )
      ];

      const estadoGestion =
        await obtenerEstado(
          "GESTION",
          "PENDIENTE",
          trx
        );

      const estadoLocal =
        await obtenerEstado(
          "GESTION_LOCAL",
          "PENDIENTE",
          trx
        );

      if (
        !estadoGestion ||
        !estadoLocal
      ) {
        await trx.rollback();

        return res
          .status(500)
          .json({
            error:
              "No se encontraron los estados iniciales"
          });
      }

      const usuarioId =
        req.user?.id ??
        null;

      const [gestion] =
        await trx(
          "gestiones"
        )
          .insert({
            nombre:
              nombre.trim(),
            descripcion:
              descripcion?.trim() ||
              null,
            version:
              version?.trim() ||
              null,
            fecha_inicio:
              fecha_inicio ||
              trx.fn.now(),
            estado_id:
              estadoGestion.id,
            creado_por:
              usuarioId,
            created_at:
              trx.fn.now(),
            updated_at:
              trx.fn.now()
          })
          .returning("*");

      const localesInsertar =
        idsLocales.map(
          connectionId => ({
            gestion_id:
              gestion.id,
            connection_id:
              connectionId,
            estado_id:
              estadoLocal.id,
            comentario:
              null,
            fecha_aplicacion:
              null,
            actualizado_por:
              usuarioId,
            created_at:
              trx.fn.now(),
            updated_at:
              trx.fn.now()
          })
        );

      await trx(
        "gestiones_locales"
      ).insert(
        localesInsertar
      );

      await trx.commit();

      res
        .status(201)
        .json({
          message:
            "Gestión creada correctamente",
          id:
            gestion.id,
          empresas,
          total_locales:
            idsLocales.length
        });

    } catch (error) {
      await trx.rollback();

      console.error(
        "Error creando gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error creando gestión"
        });
    }
  }
);

/* =========================================================
   PUT /gestiones/:id
   EDITAR DATOS GENERALES

   Solo Admin y N2.
========================================================= */

router.put("/:id", allowRoles("Admin","N2"), async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        nombre,
        descripcion,
        version,
        fecha_inicio
      } = req.body;

      const gestion =
        await db(
          "gestiones"
        )
          .where({
            id
          })
          .first();

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const cambios = {
        updated_at:
          db.fn.now()
      };

      if (
        nombre !==
        undefined
      ) {
        if (
          !String(
            nombre
          ).trim()
        ) {
          return res
            .status(400)
            .json({
              error:
                "El nombre no puede estar vacío"
            });
        }

        cambios.nombre =
          String(
            nombre
          ).trim();
      }

      if (
        descripcion !==
        undefined
      ) {
        cambios.descripcion =
          String(
            descripcion
          ).trim() ||
          null;
      }

      if (
        version !==
        undefined
      ) {
        cambios.version =
          String(
            version
          ).trim() ||
          null;
      }

      if (
        fecha_inicio !==
        undefined
      ) {
        cambios.fecha_inicio =
          fecha_inicio;
      }

      const [actualizada] =
        await db(
          "gestiones"
        )
          .where({
            id
          })
          .update(
            cambios
          )
          .returning("*");

      res.json(
        actualizada
      );

    } catch (error) {
      console.error(
        "Error actualizando gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error actualizando gestión"
        });
    }
  }
);

/* =========================================================
   POST /gestiones/:id/locales
   AGREGAR LOCALES

   Solo Admin y N2.

   BODY:
   {
     connection_ids: [10,20,30]
   }
========================================================= */

router.post("/:id/locales",allowRoles("Admin", "N2"), async (req, res) => {
    const trx =
      await db.transaction();

    try {
      const { id } =
        req.params;

      const {
        connection_ids
      } = req.body;

      const gestion =
        await trx(
          "gestiones"
        )
          .where({
            id
          })
          .first();

      if (!gestion) {
        await trx.rollback();

        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      if (
        !Array.isArray(
          connection_ids
        ) ||
        !connection_ids.length
      ) {
        await trx.rollback();

        return res
          .status(400)
          .json({
            error:
              "Debe seleccionar al menos un local"
          });
      }

      const idsLocales = [
        ...new Set(
          connection_ids
            .map(Number)
            .filter(
              value =>
                Number.isInteger(
                  value
                ) &&
                value > 0
            )
        )
      ];

      const localesValidos =
        await trx(
          "connections"
        )
          .select(
            "id",
            "empresa_id"
          )
          .whereIn(
            "id",
            idsLocales
          );

      if (
        localesValidos
          .length !==
        idsLocales.length
      ) {
        await trx.rollback();

        return res
          .status(400)
          .json({
            error:
              "Uno o más locales no existen"
          });
      }

      const existentes =
        await trx(
          "gestiones_locales"
        )
          .select(
            "connection_id"
          )
          .where(
            "gestion_id",
            id
          )
          .whereIn(
            "connection_id",
            idsLocales
          );

      const idsExistentes =
        new Set(
          existentes.map(
            item =>
              Number(
                item.connection_id
              )
          )
        );

      const nuevos =
        idsLocales.filter(
          connectionId =>
            !idsExistentes.has(
              connectionId
            )
        );

      if (!nuevos.length) {
        await trx.rollback();

        return res
          .status(409)
          .json({
            error:
              "Todos los locales seleccionados ya pertenecen a la gestión"
          });
      }

      const estadoPendiente =
        await obtenerEstado(
          "GESTION_LOCAL",
          "PENDIENTE",
          trx
        );

      if (
        !estadoPendiente
      ) {
        await trx.rollback();

        return res
          .status(500)
          .json({
            error:
              "Estado PENDIENTE de local no configurado"
          });
      }

      const usuarioId =
        req.user?.id ??
        null;

      await trx(
        "gestiones_locales"
      ).insert(
        nuevos.map(
          connectionId => ({
            gestion_id:
              id,
            connection_id:
              connectionId,
            estado_id:
              estadoPendiente.id,
            comentario:
              null,
            fecha_aplicacion:
              null,
            actualizado_por:
              usuarioId,
            created_at:
              trx.fn.now(),
            updated_at:
              trx.fn.now()
          })
        )
      );

      await trx.commit();

      res
        .status(201)
        .json({
          message:
            "Locales agregados correctamente",
          agregados:
            nuevos.length
        });

    } catch (error) {
      await trx.rollback();

      console.error(
        "Error agregando locales:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error agregando locales"
        });
    }
  }
);

/* =========================================================
   PUT /gestiones/:id/locales/:connectionId
   CAMBIAR ESTADO DE UN LOCAL

   Admin / N2:
   - Pueden modificar cualquiera.

   N1:
   - Solo una gestión asignada a él.
========================================================= */

router.put(
  "/:id/locales/:connectionId",
  allowRoles(
    "Admin",
    "N1",
    "N2"
  ),
  async (req, res) => {
    try {
      const {
        id,
        connectionId
      } = req.params;

      const {
        estado_id,
        comentario
      } = req.body;

      const gestion =
        await obtenerGestionPermitida(
          id,
          req.user
        );

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada o no asignada al usuario"
          });
      }

      if (!estado_id) {
        return res
          .status(400)
          .json({
            error:
              "El estado es obligatorio"
          });
      }

      const localGestion =
        await db(
          "gestiones_locales"
        )
          .where({
            gestion_id:
              id,
            connection_id:
              connectionId
          })
          .first();

      if (
        !localGestion
      ) {
        return res
          .status(404)
          .json({
            error:
              "El local no pertenece a esta gestión"
          });
      }

      const estado =
        await db(
          "estados"
        )
          .where({
            id:
              estado_id,
            grupo:
              "GESTION_LOCAL",
            activo:
              true
          })
          .first();

      if (!estado) {
        return res
          .status(400)
          .json({
            error:
              "Estado de local no válido"
          });
      }

      if (
        estado.codigo ===
          "NO_APLICADO" &&
        !comentario?.trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              "Debe ingresar un comentario cuando el estado es No aplicado"
          });
      }

      const cambios = {
        estado_id:
          estado.id,
        comentario:
          comentario?.trim() ||
          null,
        actualizado_por:
          req.user?.id ??
          null,
        updated_at:
          db.fn.now()
      };

      if (
        estado.codigo ===
        "TERMINADO"
      ) {
        if (
          Number(
            localGestion.estado_id
          ) !==
          Number(
            estado.id
          )
        ) {
          cambios.fecha_aplicacion =
            db.fn.now();
        }
      } else {
        cambios.fecha_aplicacion =
          null;
      }

      const [actualizado] =
        await db(
          "gestiones_locales"
        )
          .where({
            gestion_id:
              id,
            connection_id:
              connectionId
          })
          .update(
            cambios
          )
          .returning("*");

      res.json(
        actualizado
      );

    } catch (error) {
      console.error(
        "Error actualizando estado del local:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error actualizando estado del local"
        });
    }
  }
);

/* =========================================================
   POST /gestiones/:id/iniciar

   N1 puede iniciar solamente
   una gestión asignada a él.
========================================================= */

router.post(
  "/:id/iniciar",
  allowRoles(
    "Admin",
    "N2"
  ),
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const gestion =
        await obtenerGestionPermitida(
          id,
          req.user
        );

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const estado =
        await obtenerEstado(
          "GESTION",
          "EN_EJECUCION"
        );

      if (!estado) {
        return res
          .status(500)
          .json({
            error:
              "Estado EN_EJECUCION no configurado"
          });
      }

      await db(
        "gestiones"
      )
        .where({
          id
        })
        .update({
          estado_id:
            estado.id,
          updated_at:
            db.fn.now()
        });

      res.json({
        message:
          "Gestión iniciada correctamente"
      });

    } catch (error) {
      console.error(
        "Error iniciando gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error iniciando gestión"
        });
    }
  }
);

/* =========================================================
   POST /gestiones/:id/suspender
========================================================= */

router.post(
  "/:id/suspender",
  allowRoles(
    "Admin",
    "N2"
  ),
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        motivo
      } = req.body;

      if (
        !motivo?.trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              "Debe indicar el motivo de la suspensión"
          });
      }

      const gestion =
        await obtenerGestionPermitida(
          id,
          req.user
        );

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const estado =
        await obtenerEstado(
          "GESTION",
          "SUSPENDIDA"
        );

      if (!estado) {
        return res
          .status(500)
          .json({
            error:
              "Estado SUSPENDIDA no configurado"
          });
      }

      await db(
        "gestiones"
      )
        .where({
          id
        })
        .update({
          estado_id:
            estado.id,
          motivo_suspension:
            motivo.trim(),
          suspendida_at:
            db.fn.now(),
          updated_at:
            db.fn.now()
        });

      res.json({
        message:
          "Gestión suspendida correctamente"
      });

    } catch (error) {
      console.error(
        "Error suspendiendo gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error suspendiendo gestión"
        });
    }
  }
);

/* =========================================================
   POST /gestiones/:id/reanudar
========================================================= */

router.post(
  "/:id/reanudar",
  allowRoles(
    "Admin",
    "N2"
  ),
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const gestion =
        await obtenerGestionPermitida(
          id,
          req.user
        );

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const estadoActual =
        await db(
          "estados"
        )
          .where(
            "id",
            gestion.estado_id
          )
          .first();

      if (
        estadoActual?.codigo !==
        "SUSPENDIDA"
      ) {
        return res
          .status(400)
          .json({
            error:
              "La gestión no está suspendida"
          });
      }

      const estado =
        await obtenerEstado(
          "GESTION",
          "EN_EJECUCION"
        );

      if (!estado) {
        return res
          .status(500)
          .json({
            error:
              "Estado EN_EJECUCION no configurado"
          });
      }

      await db(
        "gestiones"
      )
        .where({
          id
        })
        .update({
          estado_id:
            estado.id,
          /*
           Conservamos motivo_suspension
           y suspendida_at como antecedente
           de la última suspensión.
          */
          updated_at:
            db.fn.now()
        });

      res.json({
        message:
          "Gestión reanudada correctamente"
      });

    } catch (error) {
      console.error(
        "Error reanudando gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error reanudando gestión"
        });
    }
  }
);

/* =========================================================
   POST /gestiones/:id/finalizar
========================================================= */

router.post(
  "/:id/finalizar",
  allowRoles(
    "Admin",
    "N2"
  ),
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const gestion =
        await obtenerGestionPermitida(
          id,
          req.user
        );

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const pendientes =
        await db(
          "gestiones_locales as gl"
        )
          .join(
            "estados as e",
            "e.id",
            "gl.estado_id"
          )
          .where(
            "gl.gestion_id",
            id
          )
          .where(
            "e.grupo",
            "GESTION_LOCAL"
          )
          .where(
            "e.codigo",
            "PENDIENTE"
          )
          .count(
            "* as total"
          )
          .first();

      if (
        Number(
          pendientes?.total ||
          0
        ) > 0
      ) {
        return res
          .status(400)
          .json({
            error:
              "No se puede finalizar la gestión mientras existan locales pendientes"
          });
      }

      const estado =
        await obtenerEstado(
          "GESTION",
          "FINALIZADA"
        );

      if (!estado) {
        return res
          .status(500)
          .json({
            error:
              "Estado FINALIZADA no configurado"
          });
      }

      await db(
        "gestiones"
      )
        .where({
          id
        })
        .update({
          estado_id:
            estado.id,
          fecha_fin:
            db.fn.now(),
          updated_at:
            db.fn.now()
        });

      res.json({
        message:
          "Gestión finalizada correctamente"
      });

    } catch (error) {
      console.error(
        "Error finalizando gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error finalizando gestión"
        });
    }
  }
);

/* =========================================================
   POST /gestiones/:id/cancelar

   Solo Admin.
========================================================= */

router.post(
  "/:id/cancelar",
  allowRoles(
    "Admin"
  ),
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const {
        motivo
      } = req.body;

      if (
        !motivo?.trim()
      ) {
        return res
          .status(400)
          .json({
            error:
              "Debe indicar el motivo de cancelación"
          });
      }

      const gestion =
        await db(
          "gestiones"
        )
          .where({
            id
          })
          .first();

      if (!gestion) {
        return res
          .status(404)
          .json({
            error:
              "Gestión no encontrada"
          });
      }

      const estado =
        await obtenerEstado(
          "GESTION",
          "CANCELADA"
        );

      if (!estado) {
        return res
          .status(500)
          .json({
            error:
              "Estado CANCELADA no configurado"
          });
      }

      await db(
        "gestiones"
      )
        .where({
          id
        })
        .update({
          estado_id:
            estado.id,
          motivo_suspension:
            motivo.trim(),
          fecha_fin:
            db.fn.now(),
          updated_at:
            db.fn.now()
        });

      res.json({
        message:
          "Gestión cancelada correctamente"
      });

    } catch (error) {
      console.error(
        "Error cancelando gestión:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Error cancelando gestión"
        });
    }
  }
);

export default router;