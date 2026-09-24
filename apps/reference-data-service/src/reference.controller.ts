import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '@erp/auth';
import { INDUSTRIES, languageSchema } from '@erp/contracts';
import { AppError } from '@erp/service-kit';
import {
  getCountry,
  listCountries,
  listCurrencies,
  listLanguages,
  listTimezones,
} from './reference.data';

const CACHE = 'public, max-age=3600';

function lang(value?: string): string {
  return value && languageSchema.safeParse(value).success ? value : 'en';
}

@ApiTags('reference')
@Public()
@Controller('api/v1/reference')
export class ReferenceController {
  @Get('countries')
  @Header('Cache-Control', CACHE)
  @ApiQuery({ name: 'lang', required: false, description: 'Language for names, e.g. ar, hi' })
  countries(@Query('lang') l?: string) {
    return listCountries(lang(l));
  }

  @Get('countries/:code')
  @Header('Cache-Control', CACHE)
  @ApiQuery({ name: 'lang', required: false })
  country(@Param('code') code: string, @Query('lang') l?: string) {
    const c = getCountry(code, lang(l));
    if (!c) throw AppError.notFound('Country');
    return c;
  }

  @Get('currencies')
  @Header('Cache-Control', CACHE)
  @ApiQuery({ name: 'lang', required: false })
  currencies(@Query('lang') l?: string) {
    return listCurrencies(lang(l));
  }

  @Get('languages')
  @Header('Cache-Control', CACHE)
  @ApiQuery({ name: 'lang', required: false })
  languages(@Query('lang') l?: string) {
    return listLanguages(lang(l));
  }

  @Get('timezones')
  @Header('Cache-Control', CACHE)
  timezones() {
    return listTimezones();
  }

  @Get('industries')
  @Header('Cache-Control', CACHE)
  industries() {
    return INDUSTRIES;
  }
}
