import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Config } from "@prisma/client";
import * as argon from "argon2";
import { EventEmitter } from "events";
import * as fs from "fs";
import { PrismaService } from "src/prisma/prisma.service";
import {
  parseTimespan,
  stringToTimespan,
  validateTimespanString,
} from "src/utils/date.util";
import { parse as yamlParse } from "yaml";
import { YamlConfig } from "../../prisma/seed/config.seed";
import { CONFIG_FILE } from "src/constants";

/**
 * Config variables of type `timespan`. Listing them here lets
 * `validateConfigVariable` enforce the timespan rules even when it is called
 * without an explicit `type` (e.g. from tests), and documents which keys the
 * timespan handling applies to.
 */
const TIMESPAN_CONFIG_KEYS = ["general.sessionDuration", "share.maxExpiration"];

/**
 * ConfigService extends EventEmitter to allow listening for config updates,
 * now only `update` event will be emitted.
 */
@Injectable()
export class ConfigService extends EventEmitter {
  yamlConfig?: YamlConfig;
  logger = new Logger(ConfigService.name);

  constructor(
    @Inject("CONFIG_VARIABLES") private configVariables: Config[],
    private prisma: PrismaService,
  ) {
    super();
  }

  // Initialize gets called by the ConfigModule
  async initialize() {
    await this.loadYamlConfig();

    if (this.yamlConfig) {
      await this.migrateInitUser();
    }
  }

  private async loadYamlConfig() {
    let configFile: string = "";
    try {
      configFile = fs.readFileSync(CONFIG_FILE, "utf8");
    } catch (e) {
      this.logger.log(
        "Config.yaml is not set. Falling back to UI configuration.",
      );
    }
    try {
      this.yamlConfig = yamlParse(configFile);

      if (this.yamlConfig) {
        for (const configVariable of this.configVariables) {
          const category = this.yamlConfig[configVariable.category];
          if (!category) continue;
          configVariable.value = category[configVariable.name];
          this.emit("update", configVariable.name, configVariable.value);
        }
      }
    } catch (e) {
      this.logger.error(
        "Failed to parse config.yaml. Falling back to UI configuration: ",
        e,
      );
    }
  }

  private async migrateInitUser(): Promise<void> {
    if (!this.yamlConfig.initUser.enabled) return;

    const userCount = await this.prisma.user.count({
      where: { isAdmin: true },
    });
    if (userCount === 1) {
      this.logger.log(
        "Skip initial user creation. Admin user is already existent.",
      );
      return;
    }
    await this.prisma.user.create({
      data: {
        email: this.yamlConfig.initUser.email,
        username: this.yamlConfig.initUser.username,
        password: this.yamlConfig.initUser.password
          ? await argon.hash(this.yamlConfig.initUser.password)
          : null,
        isAdmin: this.yamlConfig.initUser.isAdmin,
      },
    });
  }

  get(key: `${string}.${string}`): any {
    const configVariable = this.configVariables.filter(
      (variable) => `${variable.category}.${variable.name}` == key,
    )[0];

    if (!configVariable) throw new Error(`Config variable ${key} not found`);

    const value = configVariable.value ?? configVariable.defaultValue;

    if (configVariable.type == "number" || configVariable.type == "filesize")
      return parseInt(value);
    if (configVariable.type == "boolean") return value == "true";
    if (configVariable.type == "string" || configVariable.type == "text")
      return value;
    if (configVariable.type == "timespan") {
      const parsed = parseTimespan(value);
      if (parsed) return parsed;

      // Historical / dirty value that predates validation — never let it crash
      // a consumer (share creation, session renewal, the config endpoint, …).
      // Fall back to this variable's own default rather than a generic value:
      // e.g. `general.sessionDuration` must stay "3 months", not "0 days",
      // which would expire every session immediately.
      this.logger.warn(
        `Config variable "${key}" has an invalid timespan value "${value}". Falling back to its default "${configVariable.defaultValue}".`,
      );
      return stringToTimespan(configVariable.defaultValue);
    }
  }

  async getByCategory(category: string) {
    const configVariables = this.configVariables
      .filter((c) => !c.locked && category == c.category)
      .sort((c) => c.order);

    return configVariables.map((variable) => {
      return {
        ...variable,
        key: `${variable.category}.${variable.name}`,
        value: variable.value ?? variable.defaultValue,
        allowEdit: this.isEditAllowed(),
      };
    });
  }

  async list() {
    const configVariables = this.configVariables.filter((c) => !c.secret);

    return configVariables.map((variable) => {
      return {
        ...variable,
        key: `${variable.category}.${variable.name}`,
        value: variable.value ?? variable.defaultValue,
      };
    });
  }

  async updateMany(data: { key: string; value: string | number | boolean }[]) {
    if (!this.isEditAllowed())
      throw new BadRequestException(
        "You are only allowed to update config variables via the config.yaml file",
      );

    // Validate the whole batch up-front so a single invalid value (e.g. a bad
    // timespan) rejects the entire save instead of leaving a partial update
    // where some variables were already written.
    for (const variable of data) {
      await this.assertValidUpdate(variable.key, variable.value);
    }

    const response: Config[] = [];

    for (const variable of data) {
      response.push(await this.update(variable.key, variable.value));
    }

    return response;
  }

  async update(key: string, value: string | number | boolean) {
    if (!this.isEditAllowed())
      throw new BadRequestException(
        "You are only allowed to update config variables via the config.yaml file",
      );

    const { normalizedValue } = await this.assertValidUpdate(key, value);

    const updatedVariable = await this.prisma.config.update({
      where: {
        name_category: {
          category: key.split(".")[0],
          name: key.split(".")[1],
        },
      },
      data: {
        value: normalizedValue === null ? null : normalizedValue.toString(),
      },
    });

    this.configVariables = await this.prisma.config.findMany();

    this.emit("update", key, normalizedValue);

    return updatedVariable;
  }

  /**
   * Looks up a config variable, normalizes the incoming value (empty string ->
   * null) and runs every validation rule without persisting anything. Throws on
   * the first problem so callers can validate before writing.
   */
  private async assertValidUpdate(
    key: string,
    value: string | number | boolean,
  ): Promise<{
    configVariable: Config;
    normalizedValue: string | number | boolean | null;
  }> {
    const configVariable = await this.prisma.config.findUnique({
      where: {
        name_category: {
          category: key.split(".")[0],
          name: key.split(".")[1],
        },
      },
    });

    if (!configVariable || configVariable.locked)
      throw new NotFoundException("Config variable not found");

    let normalizedValue: string | number | boolean | null = value;

    if (normalizedValue === "") {
      normalizedValue = null;
    } else if (
      typeof normalizedValue != configVariable.type &&
      typeof normalizedValue == "string" &&
      configVariable.type != "text" &&
      configVariable.type != "timespan"
    ) {
      throw new BadRequestException(
        `Config variable must be of type ${configVariable.type}`,
      );
    }

    this.validateConfigVariable(key, normalizedValue, configVariable.type);

    return { configVariable, normalizedValue };
  }

  validateConfigVariable(
    key: string,
    value: string | number | boolean | null,
    type?: string,
  ) {
    const validations = [
      {
        key: "share.shareIdLength",
        condition: (value: number) => value >= 2 && value <= 50,
        message: "Share ID length must be between 2 and 50",
      },
      {
        key: "share.zipCompressionLevel",
        condition: (value: number) => value >= 0 && value <= 9,
        message: "Zip compression level must be between 0 and 9",
      },
    ];

    const validation = validations.find((validation) => validation.key == key);
    if (validation && !validation.condition(value as any)) {
      throw new BadRequestException(validation.message);
    }

    // Timespan validation. A null value means "reset to default" and is safe
    // (the default is always valid), so only non-null values are checked.
    const isTimespan =
      type === "timespan" || TIMESPAN_CONFIG_KEYS.includes(key);
    if (isTimespan && value !== null && value !== undefined) {
      // `0` means "no maximum" for `share.maxExpiration`, but for durations
      // such as `general.sessionDuration` a value of `0` would expire tokens
      // immediately and lock everyone out, so it must stay positive.
      const allowZero = key !== "general.sessionDuration";

      const error = validateTimespanString(value, { allowZero });
      if (error) {
        throw new BadRequestException(`Config variable "${key}" ${error}.`);
      }
    }
  }

  isEditAllowed(): boolean {
    return this.yamlConfig === undefined || this.yamlConfig === null;
  }
}
