import { DynamicModule, Module } from '@nestjs/common';
import { AccessReviewsController } from './access-reviews/access-reviews.controller';
import { AccessReviewsService } from './access-reviews/access-reviews.service';
import { UsersAdminController } from './admin/users-admin.controller';
import { SettingsController } from './settings/settings.controller';
import { SettingsService } from './settings/settings.service';
import { UsersAdminService } from './admin/users-admin.service';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthzGuard } from './auth/authorize';
import { OidcService } from './auth/oidc.service';
import { SessionGuard } from './auth/session.guard';
import { SessionService } from './auth/session.service';
import { StepUpController } from './auth/step-up.controller';
import { TotpService } from './auth/totp.service';
import { UserBindingService } from './auth/user-binding.service';
import { APP_CONFIG, AppConfig } from './config';
import { DbService } from './db/db.service';
import { HealthController } from './health.controller';
import { ChangeSetsController, RollbackController } from './registry/change-sets.controller';
import { ChangeSetsService } from './registry/change-sets.service';
import { ClamdScanner, DirectoryObjectStore, NoScanner } from './registry/file-handling';
import { RegistryReadService } from './registry/registry-read.service';
import { RegistryController } from './registry/registry.controller';
import { SourceDocumentsController } from './registry/source-documents.controller';
import { MALWARE_SCANNER, OBJECT_STORE, SourceDocumentsService } from './registry/source-documents.service';
import { CalculationsController } from './catalogue/calculations.controller';
import { CalculationsService } from './catalogue/calculations.service';
import { CatalogueController } from './catalogue/catalogue.controller';
import { CatalogueService } from './catalogue/catalogue.service';
import { EvidenceController } from './evidence/evidence.controller';
import { EvidenceService } from './evidence/evidence.service';
import { ExportsController } from './exports/exports.controller';
import { ExportJobsService } from './exports/export-jobs.service';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { SourceWatchController } from './source-watch/source-watch.controller';
import { SourceWatchService } from './source-watch/source-watch.service';
import { ExportsService } from './exports/exports.service';
import { ImportsController } from './imports/imports.controller';
import { ImportsService } from './imports/imports.service';
import { MAIL_SENDER, mailSender } from './notifications/mail';
import { NotificationsController } from './notifications/notifications.controller';
import { NotificationsService } from './notifications/notifications.service';
import { TariffReadService } from './tariffs/tariff-read.service';
import { TariffController } from './tariffs/tariff.controller';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        StepUpController,
        UsersAdminController,
        AccessReviewsController,
        SettingsController,
        AuditController,
        RegistryController,
        SourceDocumentsController,
        ChangeSetsController,
        RollbackController,
        TariffController,
        CatalogueController,
        CalculationsController,
        ExportsController,
        EvidenceController,
        ImportsController,
        NotificationsController,
        JobsController,
        SourceWatchController,
        HealthController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        DbService,
        AuditService,
        OidcService,
        SessionService,
        UserBindingService,
        TotpService,
        UsersAdminService,
        AccessReviewsService,
        SettingsService,
        RegistryReadService,
        SourceDocumentsService,
        ChangeSetsService,
        TariffReadService,
        CatalogueService,
        CalculationsService,
        ExportsService,
        ExportJobsService,
        EvidenceService,
        ImportsService,
        NotificationsService,
        JobsService,
        SourceWatchService,
        { provide: MAIL_SENDER, useValue: mailSender(config) },
        { provide: OBJECT_STORE, useValue: new DirectoryObjectStore(config.storageDir, { createRoot: config.storageKind === 'local' }) },
        {
          provide: MALWARE_SCANNER,
          useValue: config.clamdHost ? new ClamdScanner(config.clamdHost, config.clamdPort) : new NoScanner(),
        },
        SessionGuard,
        AuthzGuard,
      ],
    };
  }
}
