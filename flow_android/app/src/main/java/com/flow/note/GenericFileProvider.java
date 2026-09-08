package com.flow.note;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

public class GenericFileProvider extends ContentProvider {
    public static final String AUTHORITY = "com.flow.note.provider";

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String segment = uri.getLastPathSegment();
        if (segment != null) {
            // 1. Check cacheDir
            File file = new File(getContext().getCacheDir(), segment);
            if (file.exists()) {
                return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            }

            // 2. Check uploadsDir
            File uploadsDir = new File(getContext().getFilesDir(), "uploads");
            file = new File(uploadsDir, segment);
            if (file.exists()) {
                return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            }

            // 3. Check filesDir
            file = new File(getContext().getFilesDir(), segment);
            if (file.exists()) {
                return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            }
        }
        throw new FileNotFoundException("File not found for uri: " + uri.toString());
    }

    @Override
    public String getType(Uri uri) {
        String segment = uri.getLastPathSegment();
        if (segment != null) {
            String lower = segment.toLowerCase();
            if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
            if (lower.endsWith(".pdf")) return "application/pdf";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
            if (lower.endsWith(".svg")) return "image/svg+xml";
        }
        return "application/octet-stream";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        String segment = uri.getLastPathSegment();
        File file = null;
        if (segment != null) {
            File cFile = new File(getContext().getCacheDir(), segment);
            if (cFile.exists()) {
                file = cFile;
            } else {
                File uFile = new File(new File(getContext().getFilesDir(), "uploads"), segment);
                if (uFile.exists()) {
                    file = uFile;
                } else {
                    File fFile = new File(getContext().getFilesDir(), segment);
                    if (fFile.exists()) file = fFile;
                }
            }
        }

        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(cols, 1);
        if (file != null && file.exists()) {
            MatrixCursor.RowBuilder row = cursor.newRow();
            for (String col : cols) {
                if (OpenableColumns.DISPLAY_NAME.equals(col)) {
                    row.add(file.getName());
                } else if (OpenableColumns.SIZE.equals(col)) {
                    row.add(file.length());
                } else {
                    row.add(null);
                }
            }
        }
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
