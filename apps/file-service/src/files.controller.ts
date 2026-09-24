import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Internal, Public } from '@erp/auth';
import { FilesService } from './files.service';

@ApiTags('files')
@Controller('api/v1/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /** Any signed-in user can upload; the file is only useful once a record links to it. */
  @Post()
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  // Hard cap while streaming; the configured limit (MAX_UPLOAD_MB) is checked in the service.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024, files: 1 } }))
  upload(
    @UploadedFile() file?: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    return this.files.upload(file);
  }

  @Get(':id')
  @ApiBearerAuth()
  describe(@Param('id') id: string) {
    return this.files.describe(id);
  }

  /** Signed, short-lived link: works in <img src> without an Authorization header. */
  @Public()
  @Get(':id/content')
  async content(
    @Param('id') id: string,
    @Query() q: { t?: string; exp?: string; sig?: string },
    @Res() res: Response,
  ) {
    const { file, body, inline } = await this.files.open(id, q);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    body.pipe(res);
  }
}

@Controller('internal/files')
@Internal()
export class InternalFilesController {
  constructor(private readonly files: FilesService) {}

  @Get(':id')
  get(@Param('id') id: string) {
    return this.files.internalGet(id);
  }
}
