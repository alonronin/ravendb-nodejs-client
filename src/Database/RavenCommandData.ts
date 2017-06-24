import {IJsonSerializable} from '../Json/IJsonSerializable';
import {RequestMethod} from "../Http/Request/RequestMethod";

export abstract class RavenCommandData implements IJsonSerializable {
  private readonly _command: boolean = true;
  protected type: RequestMethod;
  protected key: string;
  protected etag?: number = null;
  protected additionalData?: object = null;

  constructor(key: string, etag?: number) {
    this.key = key;
    this.etag = etag;
  }

  public get command(): boolean {
    return this._command;
  }

  public get documentKey(): string {
    return this.key;
  }

  public toJson(): object {
    return {
      "Type": this.type,
      "Id": this.documentKey,
      "Etag": this.etag
    };
  }
}