import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermissions } from '@erp/auth';
import { ZodPipe } from '@erp/service-kit';
import { PacksService } from './packs.service';

const installSchema = z.object({
  resolutions: z.record(z.string().max(200), z.enum(['mine', 'pack'])).optional(),
});

/** Settings → Packs. Installing and removing change the draft; publishing makes them live. */
@ApiTags('packs')
@ApiBearerAuth()
@Controller('api/v1/packs')
@RequirePermissions('packs.manage')
export class PacksController {
  constructor(private readonly packs: PacksService) {}

  @Get()
  list() {
    return this.packs.list();
  }

  @Post(':id/preview')
  @HttpCode(200)
  preview(@Param('id') id: string) {
    return this.packs.preview(id);
  }

  @Put(':id')
  install(
    @Param('id') id: string,
    @Body(new ZodPipe(installSchema)) body: z.infer<typeof installSchema>,
  ) {
    return this.packs.install(id, body.resolutions);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.packs.remove(id);
  }

  @Post(':id/samples')
  @HttpCode(200)
  addSamples(@Param('id') id: string) {
    return this.packs.addSamples(id);
  }

  @Delete(':id/samples')
  removeSamples(@Param('id') id: string) {
    return this.packs.removeSamples(id);
  }
}
