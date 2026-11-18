-- CreateTable
CREATE TABLE "ConsumerDependency" (
    "id" TEXT NOT NULL,
    "consumerServiceId" TEXT NOT NULL,
    "providerServiceId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sends" TEXT[],
    "reads" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsumerDependency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsumerDependency_providerServiceId_idx" ON "ConsumerDependency"("providerServiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerDependency_consumerServiceId_providerServiceId_meth_key" ON "ConsumerDependency"("consumerServiceId", "providerServiceId", "method", "path");

-- AddForeignKey
ALTER TABLE "ConsumerDependency" ADD CONSTRAINT "ConsumerDependency_consumerServiceId_fkey" FOREIGN KEY ("consumerServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsumerDependency" ADD CONSTRAINT "ConsumerDependency_providerServiceId_fkey" FOREIGN KEY ("providerServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
