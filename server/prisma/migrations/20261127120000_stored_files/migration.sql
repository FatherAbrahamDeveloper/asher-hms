-- CreateTable
CREATE TABLE "StoredFile" (
    "path" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("path")
);

-- CreateIndex
CREATE INDEX "StoredFile_kind_idx" ON "StoredFile"("kind");
