import { Inject, Module, OnApplicationBootstrap } from '@nestjs/common';
import { ServiceCoreModule } from '@erp/service-kit';
import { FilesController, InternalFilesController } from './files.controller';
import { FILE_ENV, FilesService, loadFileEnv, type FileEnv } from './files.service';
import { FILE_STORAGE, MemoryStorage, S3Storage, type FileStorage } from './storage';

@Module({
  imports: [ServiceCoreModule.forRoot({ name: 'file-service' })],
  controllers: [FilesController, InternalFilesController],
  providers: [
    FilesService,
    { provide: FILE_ENV, useFactory: loadFileEnv },
    {
      provide: FILE_STORAGE,
      useFactory: (env: FileEnv): FileStorage =>
        env.STORAGE_DRIVER === 'memory'
          ? new MemoryStorage()
          : new S3Storage(env.S3_BUCKET, {
              endpoint: env.S3_ENDPOINT,
              region: env.S3_REGION,
              accessKeyId: env.S3_ACCESS_KEY ?? '',
              secretAccessKey: env.S3_SECRET_KEY ?? '',
            }),
      inject: [FILE_ENV],
    },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(@Inject(FILE_STORAGE) private readonly storage: FileStorage) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.storage.init();
  }
}
