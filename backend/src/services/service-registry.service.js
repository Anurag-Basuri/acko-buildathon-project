// Service Registry business logic.
// All Prisma access for this module lives here; controllers never query the
// database directly.
import { Prisma } from '@prisma/client';
import prisma from '../database/prisma.js';
import { ApiError } from '../utils/api-error.js';

async function createService({ name, owner, description }) {
  try {
    return await prisma.service.create({
      data: { name, owner, description },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new ApiError(
        409,
        'DUPLICATE_SERVICE',
        `A service named "${name}" already exists`
      );
    }
    throw err;
  }
}

async function listServices() {
  return prisma.service.findMany({ orderBy: { name: 'asc' } });
}

async function getService(id) {
  const service = await prisma.service.findUnique({ where: { id } });
  if (!service) {
    throw new ApiError(404, 'SERVICE_NOT_FOUND', `Service with id "${id}" was not found`);
  }
  return service;
}

// Returns the service's specification versions (metadata only — the raw
// original/parsed content is large and is served by GET /api/specs/:id
// instead). Version labels are user-supplied identifiers, so ordering is
// chronological, not lexicographic.
async function listServiceVersions(id) {
  await getService(id); // existence check -> 404 for unknown services
  return prisma.apiVersion.findMany({
    where: { serviceId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      serviceId: true,
      versionLabel: true,
      format: true,
      openApiVersion: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export { createService, listServices, getService, listServiceVersions };
