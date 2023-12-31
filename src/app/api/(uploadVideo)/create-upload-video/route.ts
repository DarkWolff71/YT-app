import { getS3Instance } from "@/lib/helpers/s3Instance";
import { createUploadVideoRequestValidator } from "@/validators/uploadVideoValidators";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "../../(authentication)/auth/[...nextauth]/options";
import { getPrismaClient } from "@/lib/helpers/prisma";
import { VideoPrivacyStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PutObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";

const s3 = getS3Instance();
const prisma = getPrismaClient();

export async function POST(req: NextRequest) {
  let validatedRequest = createUploadVideoRequestValidator.safeParse(
    await req.json()
  );
  let session = await getServerSession(authOptions);

  if (
    !(
      validatedRequest.success === true &&
      session &&
      session.user.email &&
      session.user.roomName
    )
  ) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  let privacyStatus: undefined | VideoPrivacyStatus;
  if (validatedRequest.data.privacyStatus) {
    if (validatedRequest.data.privacyStatus === "private") {
      privacyStatus = VideoPrivacyStatus.PRIVATE;
    } else if (validatedRequest.data.privacyStatus === "public") {
      privacyStatus = VideoPrivacyStatus.PUBLIC;
    } else if (validatedRequest.data.privacyStatus === "unlisted") {
      privacyStatus = VideoPrivacyStatus.UNLISTED;
    }
  }
  let owners = await prisma.room.findUnique({
    where: {
      name: session.user.roomName,
    },
    select: {
      _count: {
        select: {
          owners: true,
        },
      },
    },
  });

  if (validatedRequest.data.videoId) {
    const videoIdValidation = await prisma.room.findUnique({
      where: {
        name: session.user.roomName,
      },
      select: {
        _count: {
          select: {
            unpublishedVideos: {
              where: { id: validatedRequest.data.videoId, isEditable: true },
            },
          },
        },
      },
    });

    if (videoIdValidation?._count.unpublishedVideos !== 1) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
  }

  // thumbnail
  let thumbnailKey = "";
  let thumbnailUrl = "";
  let thumbnailSize = 0;
  let thumbnailType = "";
  if (validatedRequest.data.thumbnailFileChanged) {
    if (validatedRequest.data.videoId) {
      const existingThumbnailS3Key = await prisma.video.findUnique({
        where: { id: validatedRequest.data.videoId },
        select: { thumbnailS3Key: true },
      });
      if (existingThumbnailS3Key?.thumbnailS3Key) {
        s3.deleteObject({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: existingThumbnailS3Key.thumbnailS3Key,
        });
      }
    }
    if (validatedRequest.data.thumbnailFile) {
      const fileType = validatedRequest.data.thumbnailFile.type;
      const fileExtension = fileType.split("/")[1];
      thumbnailKey = `${
        session.user.roomName
      }_${randomUUID()}.${fileExtension}`;
      const command = new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: thumbnailKey,
        ContentType: fileType,
      });
      thumbnailUrl = await getSignedUrl(s3, command);
      thumbnailSize = validatedRequest.data.thumbnailFile.size;
      thumbnailType = validatedRequest.data.thumbnailFile.type;
    }
  }

  // video
  let videoS3Key = "";
  let videoFileSize = 0;
  let videoFileName = "";
  let uploadId = "";
  let videoType = "";
  let partSignedUrlList: {
    signedUrl: string;
    PartNumber: number;
  }[] = [];
  if (validatedRequest.data.videoFileChanged) {
    if (validatedRequest.data.videoId) {
      const existingVideoS3Key = await prisma.video.findUnique({
        where: { id: validatedRequest.data.videoId },
        select: { videoS3Key: true },
      });
      if (existingVideoS3Key?.videoS3Key) {
        s3.deleteObject({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: existingVideoS3Key.videoS3Key,
        });
      }
    }
    if (validatedRequest.data.videoFile) {
      const fileType = validatedRequest.data.videoFile.type;
      const fileExtension = fileType.split("/")[1];
      const key = `${session.user.roomName}_${randomUUID()}.${fileExtension}`;
      //initiate multipart upload
      const multipartCreateParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
      };

      const createMultipartUploadResponse = await s3.createMultipartUpload(
        multipartCreateParams
      );
      uploadId = createMultipartUploadResponse.UploadId ?? "";

      // get presigned urls
      const multipartGetUrlParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        UploadId: uploadId,
        Expires: 60 * 60 * 24, //24 hrs expiry
      };
      const totalParts = Math.ceil(
        validatedRequest.data.videoFile.size / (500 * 1000 * 1000) // each part can be max of 500 Mb
      );
      const presignedUrlpromises = [];
      for (let index = 0; index < totalParts; index++) {
        presignedUrlpromises.push(
          getSignedUrl(
            s3,
            new UploadPartCommand({
              ...multipartGetUrlParams,
              PartNumber: index + 1,
            })
          )
        );
      }
      const signedUrls = await Promise.all(presignedUrlpromises);
      partSignedUrlList = signedUrls.map((signedUrl, index) => {
        return {
          signedUrl: signedUrl,
          PartNumber: index + 1,
        };
      });
      videoS3Key = key;
      videoFileSize = validatedRequest.data.videoFile.size;
      videoFileName = validatedRequest.data.videoFile.name;
      videoType = fileType;
    }
  }

  // db
  if (validatedRequest.data.videoId) {
    await prisma.video.update({
      where: {
        id: validatedRequest.data.videoId,
      },
      data: {
        title: validatedRequest.data.title,
        description: validatedRequest.data.description,
        tags: validatedRequest.data.tags,
        categoryId: validatedRequest.data.categoryId,
        privacyStatus: privacyStatus,
        updatedAt: new Date(),
        sentForApproval: owners?._count.owners === 1 ? true : false,
        approvedByOwners: { set: [] },
        ...(validatedRequest.data.videoFileChanged && {
          videoS3Key: videoS3Key,
          videoFileSize: videoFileSize,
          videoFileName: videoFileName,
          videoType: videoType,
        }),
        ...(validatedRequest.data.thumbnailFileChanged && {
          thumbnailS3Key: thumbnailKey,
          thumbnailSize: thumbnailSize,
          thumbnailType: thumbnailType,
        }),
      },
    });
  } else {
    await prisma.video.create({
      data: {
        room: {
          connect: {
            name: session.user.roomName,
          },
        },
        title: validatedRequest.data.title,
        description: validatedRequest.data.description,
        tags: validatedRequest.data.tags,
        categoryId: validatedRequest.data.categoryId,
        privacyStatus: privacyStatus,
        updatedAt: new Date(),
        isApproved: owners?._count.owners === 1 ? true : false,
        sentForApproval: owners?._count.owners === 1 ? true : false,
        ...(validatedRequest.data.videoFileChanged && {
          videoS3Key: videoS3Key,
          videoFileSize: videoFileSize,
          videoFileName: videoFileName,
          videoType: videoType,
        }),
        ...(validatedRequest.data.thumbnailFileChanged && {
          thumbnailS3Key: thumbnailKey,
          thumbnailSize: thumbnailSize,
          thumbnailType: thumbnailType,
        }),
      },
    });
  }

  return NextResponse.json({
    ...(validatedRequest.data.thumbnailFileChanged &&
      thumbnailUrl && {
        thumbnailPresignedUrl: thumbnailUrl,
      }),
    ...(validatedRequest.data.videoFileChanged &&
      partSignedUrlList.length > 0 && {
        partSignedUrlList: partSignedUrlList,
        key: videoS3Key,
        uploadId: uploadId,
      }),
  });
}
