-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('NEW', 'ALLOCATED', 'DECLINED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Guest" ADD COLUMN     "company" TEXT,
ADD COLUMN     "nextOfKinName" TEXT,
ADD COLUMN     "nextOfKinPhone" TEXT;

-- CreateTable
CREATE TABLE "BookingRequest" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "accessTokenHash" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'NEW',
    "guestId" TEXT,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "address" TEXT NOT NULL,
    "company" TEXT,
    "nextOfKinName" TEXT NOT NULL,
    "nextOfKinPhone" TEXT NOT NULL,
    "stayType" "StayType" NOT NULL DEFAULT 'NIGHT',
    "roomTypeId" TEXT NOT NULL,
    "checkInDate" DATE NOT NULL,
    "checkInTime" TEXT NOT NULL,
    "nights" INTEGER,
    "hours" INTEGER,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "specialRequests" TEXT,
    "quotedTotal" DECIMAL(14,2) NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "transferRef" TEXT,
    "payerName" TEXT,
    "proofPath" TEXT,
    "reservationId" TEXT,
    "handledById" TEXT,
    "handledByName" TEXT,
    "handledAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_reference_key" ON "BookingRequest"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_accessTokenHash_key" ON "BookingRequest"("accessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_reservationId_key" ON "BookingRequest"("reservationId");

-- CreateIndex
CREATE INDEX "BookingRequest_status_createdAt_idx" ON "BookingRequest"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "Guest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "RoomType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

