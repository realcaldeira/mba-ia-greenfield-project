import { Matches } from 'class-validator';
import { PUBLIC_ID_PATTERN } from '../videos.constants';

export class PublicIdParamDto {
  /** Public video identifier: 11 base64url characters. */
  @Matches(PUBLIC_ID_PATTERN)
  publicId: string;
}
