from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


class Base(DeclarativeBase):
    pass


engine = create_engine(settings().database_url, pool_pre_ping=True, future=True)
# autoflush=False намеренно: иначе любой запрос внутри обработчика сбрасывает
# незакоммиченную правку в базу, ограничение segments_no_overlap срабатывает
# раньше сервисной проверки, и пользователь получает 500 вместо 422.
SessionLocal = sessionmaker(engine, expire_on_commit=False, autoflush=False,
                            future=True)


def init_db() -> None:
    """Создаёт таблицы и ограничение, которого нет в декларативной модели.

    Непересечение шагов снимаем с сервисного слоя в базу: раз Postgres, пусть
    перекрытие будет невозможно физически. EXCLUDE USING gist требует btree_gist —
    расширение ставится из migrations/init/01-extensions.sql при первом старте
    контейнера с базой.
    """
    from . import models  # noqa: F401  — регистрация таблиц

    Base.metadata.create_all(engine)
    with engine.begin() as conn:
        # create_all создаёт недостающие ТАБЛИЦЫ, но не колонки: на живой базе
        # новое поле молча не появляется, и запись падает уже в рантайме.
        # Пока нет alembic — держим список догоняющих правок здесь, явным
        # списком, а не втихую. Разрастётся до трёх-четырёх строк — заводить
        # миграции.
        for ddl in (
            "ALTER TABLE annotations ADD COLUMN IF NOT EXISTS reviewed_at "
            "TIMESTAMP WITH TIME ZONE",
            "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS degraded JSONB "
            "NOT NULL DEFAULT '[]'::jsonb",
            "ALTER TABLE annotations ADD COLUMN IF NOT EXISTS degraded JSONB "
            "NOT NULL DEFAULT '[]'::jsonb",
        ):
            conn.execute(text(ddl))
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS btree_gist"))
        # Оба ограничения — отложенные. Любая перестановка шагов (правка границы,
        # split, merge, удаление) на время транзакции нарушает и уникальность
        # индекса, и непересечение; корректно состояние только к коммиту.
        conn.execute(text("""
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint
                               WHERE conname = 'segments_annotation_index_uniq'
                                 AND condeferrable) THEN
                    ALTER TABLE segments
                        DROP CONSTRAINT IF EXISTS segments_annotation_index_uniq;
                    ALTER TABLE segments ADD CONSTRAINT segments_annotation_index_uniq
                        UNIQUE (annotation_id, index) DEFERRABLE INITIALLY DEFERRED;
                END IF;

                IF NOT EXISTS (SELECT 1 FROM pg_constraint
                               WHERE conname = 'segments_no_overlap'
                                 AND condeferrable) THEN
                    ALTER TABLE segments
                        DROP CONSTRAINT IF EXISTS segments_no_overlap;
                    ALTER TABLE segments ADD CONSTRAINT segments_no_overlap
                        EXCLUDE USING gist (
                            annotation_id WITH =,
                            numrange(start_s::numeric, end_s::numeric) WITH &&
                        ) DEFERRABLE INITIALLY DEFERRED;
                END IF;
            END $$;
        """))


def get_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
